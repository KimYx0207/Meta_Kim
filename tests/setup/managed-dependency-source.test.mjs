import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { componentHash, stableJson, sha256 } from "../../scripts/dependency-agent-discovery.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const moduleUrl = relative => pathToFileURL(path.join(root, relative)).href;
const project = { id: "kim-service", source: { localPath: null }, interface: {
  capabilityIndex: { format: "component-capabilities-v1", path: "generated/capabilities.json", rootEnv: "META_KIM_KIM_SERVICE_ROOT" },
} };
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

async function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "meta-service-managed-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, "Home Space"), source = path.join(temporary, "source");
  fs.mkdirSync(home); fs.mkdirSync(source);
  put(path.join(source, ".git/config"), "fixture\n");
  put(path.join(source, "private.local.md"), "do not copy\n");
  const components = [], capabilities = [];
  for (const [kind, id] of [["agent", "example-engineer"], ["skill", "find-skill"]]) {
    const relative = `${kind === "agent" ? "agents" : "skills"}/${id}`;
    const directory = path.join(source, relative);
    const entrypoint = kind === "agent" ? "AGENT.md" : "SKILL.md";
    put(path.join(directory, entrypoint), `---\nname: ${id}\ndescription: Example fixture method\n${kind === "agent" ? "tools: Read\n" : ""}---\n\nRead the supplied example evidence.\n`);
    put(path.join(directory, "LICENSE"), "fixture license\n");
    put(path.join(directory, "check.mjs"), 'throw new Error("Discovery must not execute checks");\n');
    const capability = { id: kind === "agent" ? id : "example-method", summary: "example method", useWhen: ["example method"], doNotUseWhen: ["external writes"],
      input: { type: "object", required: [] }, output: { type: "object", required: [] }, permissions: ["filesystem:read-user-materials"],
      sideEffects: [], humanGate: { required: false, when: [] }, validation: ["check.mjs"] };
    const contract = { schemaVersion: 1, id, componentType: kind, componentVersion: "1.0.0", entrypoint, capabilities: [capability] };
    put(path.join(directory, "capability.json"), JSON.stringify(contract));
    const contentSha256 = await componentHash(directory), contractSha256 = sha256(stableJson(contract));
    components.push({ id, path: relative, componentType: kind, componentVersion: "1.0.0", entrypoint,
      capabilityIds: [capability.id], validation: ["check.mjs"], contentSha256, contractSha256 });
    capabilities.push({ ...capability, componentId: id, componentType: kind, componentVersion: "1.0.0", componentPath: relative,
      entrypoint, componentContentSha256: contentSha256, contractSha256 });
  }
  put(path.join(source, "generated/capabilities.json"), JSON.stringify({ schemaVersion: 1, components, capabilities,
    componentCount: components.length, capabilityCount: capabilities.length }));
  return { home, source, temporary };
}

function child(fixture, source) {
  const env = { ...process.env, HOME: fixture.home, USERPROFILE: fixture.home };
  delete env.META_KIM_KIM_SERVICE_ROOT;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    env, encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("managed source makes agents and skills discoverable without a project override and excludes private files", async t => {
  const f = await fixture(t);
  const result = child(f, `
    import fs from 'node:fs';
    import { materializeManagedServiceSource, readManagedServiceSource } from ${JSON.stringify(moduleUrl("scripts/managed-dependency-source.mjs"))};
    import { discoverDependencyAgentContracts } from ${JSON.stringify(moduleUrl("scripts/dependency-agent-discovery.mjs"))};
    import { discoverDependencySkillContracts } from ${JSON.stringify(moduleUrl("scripts/dependency-skill-discovery.mjs"))};
    const value=await materializeManagedServiceSource({sourceRoot:${JSON.stringify(f.source)},metaKimVersion:'fixture'});
    const options={projects:[${JSON.stringify(project)}],projectRoot:${JSON.stringify(f.temporary)},environment:process.env};
    const agents=await discoverDependencyAgentContracts(options);
    const skills=await discoverDependencySkillContracts({...options,capabilityNeedIds:['example-method']});
    console.log(JSON.stringify({value,readback:readManagedServiceSource().value,agents:agents.agents.map(a=>a.id),skills:skills.capabilities.map(s=>s.id),
      privateCopied:fs.existsSync(value+'/private.local.md'),gitCopied:fs.existsSync(value+'/.git')}));
  `);
  assert.equal(result.value, result.readback);
  assert.deepEqual(result.agents, ["kim-service:example-engineer"]);
  assert.deepEqual(result.skills, ["kim-service:example-method"]);
  assert.equal(result.privateCopied, false); assert.equal(result.gitCopied, false);
});

test("managed sources record actual checkout revision and preserve the previous source on revision failure", async t => {
  const f = await fixture(t);
  fs.rmSync(path.join(f.source, ".git"), { recursive: true, force: true });
  const git = args => {
    const result = spawnSync("git", ["-C", f.source, ...args], { encoding: "utf8", env: { ...process.env, HOME: f.home, USERPROFILE: f.home } });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(["init", "--quiet"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "core.hooksPath", path.join(f.temporary, "no-hooks")]); git(["add", "."]); git(["commit", "--quiet", "-m", "reviewed fixture"]);
  const commit = git(["rev-parse", "HEAD"]);
  const result = child(f, `
    import { materializeManagedServiceSource, readManagedServiceSource } from ${JSON.stringify(moduleUrl("scripts/managed-dependency-source.mjs"))};
    const sourceRoot=${JSON.stringify(f.source)};
    const local=await materializeManagedServiceSource({sourceRoot,metaKimVersion:'fixture'});
    const localRevision=readManagedServiceSource().revision;
    const revision={schemaVersion:1,selection:'reviewed_commit',repository:'fixture/Kim_Service',commit:${JSON.stringify(commit)}};
    const reviewed=await materializeManagedServiceSource({sourceRoot,metaKimVersion:'fixture',sourceRevision:revision});
    let error; try {await materializeManagedServiceSource({sourceRoot,metaKimVersion:'fixture',sourceRevision:{...revision,commit:'0'.repeat(40)}});}catch(e){error=e.message;}
    const current=readManagedServiceSource();
    console.log(JSON.stringify({localRevision,distinct:reviewed!==local,current:current.revision,kept:current.value===reviewed,error}));
  `);
  assert.equal(result.localRevision.selection, "local_override");
  assert.equal(result.localRevision.commit, null);
  assert.equal(result.distinct, true); assert.equal(result.kept, true);
  assert.equal(result.current.commit, commit); assert.equal(result.current.selection, "reviewed_commit");
  assert.match(result.error, /differs from the checkout/);
});

test("explicit missing roots override the installed source; drifted managed bytes never fall back", async t => {
  const f = await fixture(t);
  const result = child(f, `
    import fs from 'node:fs';
    import { materializeManagedServiceSource } from ${JSON.stringify(moduleUrl("scripts/managed-dependency-source.mjs"))};
    import { discoverDependencyAgentContracts } from ${JSON.stringify(moduleUrl("scripts/dependency-agent-discovery.mjs"))};
    const value=await materializeManagedServiceSource({sourceRoot:${JSON.stringify(f.source)},metaKimVersion:'fixture'});
    const options={projects:[${JSON.stringify(project)}],projectRoot:${JSON.stringify(f.temporary)}};
    const missing=await discoverDependencyAgentContracts({...options,environment:{...process.env,META_KIM_KIM_SERVICE_ROOT:value+'/missing'}});
    fs.appendFileSync(value+'/agents/example-engineer/AGENT.md','changed');
    const drift=await discoverDependencyAgentContracts({...options,environment:process.env});
    console.log(JSON.stringify({missing:missing.sources[0].status,missingAgents:missing.agents.length,drift:drift.sources[0].status,driftAgents:drift.agents.length}));
  `);
  assert.deepEqual(result, { missing: "missing", missingAgents: 0, drift: "invalid", driftAgents: 0 });
});

test("the actual host prefers its native home variable when the inherited other-platform variable conflicts", async t=>{
  const f=await fixture(t);
  const result=child(f, `
    import {materializeManagedServiceSource,dependencyRootBinding} from ${JSON.stringify(moduleUrl("scripts/managed-dependency-source.mjs"))};
    const source=await materializeManagedServiceSource({sourceRoot:${JSON.stringify(f.source)},metaKimVersion:'fixture'});
    const environment={...process.env,[process.platform==='win32'?'HOME':'USERPROFILE']:${JSON.stringify(path.join(f.temporary,"wrong platform home"))}};
    const selected=dependencyRootBinding(${JSON.stringify(project)},{},environment),empty=dependencyRootBinding(${JSON.stringify(project)},{},{});
    console.log(JSON.stringify({correct:selected.value===source,emptyValue:empty.value}));
  `);
  assert.deepEqual(result,{correct:true,emptyValue:null});
});

for (const scenario of ["private component file", "contract drift", "index entrypoint drift"]) {
  test(`${scenario} fails before creating a managed source or copying unknown content`, async t => {
    const f = await fixture(t);
    if (scenario === "private component file") put(path.join(f.source, "agents/example-engineer/.env"), "PRIVATE_FIXTURE=do-not-copy\n");
    if (scenario === "contract drift") fs.appendFileSync(path.join(f.source, "agents/example-engineer/capability.json"), " ");
    if (scenario === "index entrypoint drift") {
      const indexPath=path.join(f.source,"generated/capabilities.json"),index=JSON.parse(fs.readFileSync(indexPath,"utf8"));
      index.components[0].entrypoint="other.md"; put(indexPath,JSON.stringify(index));
    }
    const result = child(f, `
      import fs from 'node:fs';
      import {materializeManagedServiceSource} from ${JSON.stringify(moduleUrl("scripts/managed-dependency-source.mjs"))};
      let error;try{await materializeManagedServiceSource({sourceRoot:${JSON.stringify(f.source)},metaKimVersion:'fixture'});}catch(e){error=e.message;}
      console.log(JSON.stringify({error,storeCreated:fs.existsSync(${JSON.stringify(path.join(f.home,".meta-kim/runtime/dependency-projects/kim-service"))}),manifestCreated:fs.existsSync(${JSON.stringify(path.join(f.home,".meta-kim/install-manifest.json"))})}));
    `);
    assert.match(result.error,/hash mismatch|differs from component contract/);
    assert.equal(result.storeCreated,false); assert.equal(result.manifestCreated,false);
  });
}

test("an update registers a new source without overwriting the prior source", async t => {
  const f = await fixture(t);
  const result = child(f, `
    import fs from 'node:fs';
    import { materializeManagedServiceSource, readManagedServiceSource } from ${JSON.stringify(moduleUrl("scripts/managed-dependency-source.mjs"))};
    const source=${JSON.stringify(f.source)};
    const before=await materializeManagedServiceSource({sourceRoot:source,metaKimVersion:'fixture'});
    fs.writeFileSync(source+'/VERSION','V-next');
    const after=await materializeManagedServiceSource({sourceRoot:source,metaKimVersion:'fixture'});
    const ledger=${JSON.stringify(path.join(f.home,".meta-kim/install-manifest.json"))};
    const manifest=JSON.parse(fs.readFileSync(ledger,'utf8'));for(const entry of manifest.entries)entry.installedAt='2026-01-01T00:00:00.000Z';fs.writeFileSync(ledger,JSON.stringify(manifest));
    console.log(JSON.stringify({changed:before!==after,current:readManagedServiceSource().value===after,oldPresent:fs.existsSync(before+'/generated/capabilities.json')}));
  `);
  assert.deepEqual(result, { changed: true, current: true, oldPresent: true });
});

test("a copy failure leaves no registered or stable managed source", async t => {
  const f=await fixture(t);
  const result=child(f, `
    import fs from 'node:fs';
    import {materializeManagedServiceSource} from ${JSON.stringify(moduleUrl("scripts/managed-dependency-source.mjs"))};
    const original=fs.promises.copyFile;fs.promises.copyFile=async()=>{throw new Error('fixture copy denied');};
    let error;try{await materializeManagedServiceSource({sourceRoot:${JSON.stringify(f.source)},metaKimVersion:'fixture'});}catch(e){error=e.message;}finally{fs.promises.copyFile=original;}
    const store=${JSON.stringify(path.join(f.home,".meta-kim/runtime/dependency-projects/kim-service"))};
    console.log(JSON.stringify({error,stable:fs.readdirSync(store).filter(name=>/^[a-f0-9]{64}$/.test(name)).length,staging:fs.readdirSync(store).filter(name=>name.startsWith('.staged-')).length,manifest:fs.existsSync(${JSON.stringify(path.join(f.home,".meta-kim/install-manifest.json"))})}));
  `);
  assert.deepEqual(result,{error:"fixture copy denied",stable:0,staging:0,manifest:false});
});

test("manifest flush failure is reported and never makes the unregistered source discoverable", async t => {
  const f=await fixture(t),ledger=path.join(f.home,".meta-kim/install-manifest.json");
  put(ledger,"invalid fixture manifest\n");
  const result=child(f, `
    import fs from 'node:fs';
    import {materializeManagedServiceSource,readManagedServiceSource} from ${JSON.stringify(moduleUrl("scripts/managed-dependency-source.mjs"))};
    let error,readError;try{await materializeManagedServiceSource({sourceRoot:${JSON.stringify(f.source)},metaKimVersion:'fixture'});}catch(e){error=e.message;}
    try{readManagedServiceSource();}catch(e){readError=e.message;}
    console.log(JSON.stringify({error,readError,manifest:fs.readFileSync(${JSON.stringify(ledger)},'utf8')}));
  `);
  assert.match(result.error,/receipt flush failed/);assert.match(result.readError,/manifest is invalid/);
  assert.equal(result.manifest,"invalid fixture manifest\n");
});

test("an existing changed source is preserved rather than overwritten or adopted", async t => {
  const f=await fixture(t);
  const result=child(f, `
    import fs from 'node:fs';
    import {materializeManagedServiceSource} from ${JSON.stringify(moduleUrl("scripts/managed-dependency-source.mjs"))};
    const options={sourceRoot:${JSON.stringify(f.source)},metaKimVersion:'fixture'},value=await materializeManagedServiceSource(options);
    fs.writeFileSync(value+'/user-owned.txt','preserve me');let error;try{await materializeManagedServiceSource(options);}catch(e){error=e.message;}
    console.log(JSON.stringify({error,retained:fs.readFileSync(value+'/user-owned.txt','utf8')}));
  `);
  assert.match(result.error,/unowned or changed/);assert.equal(result.retained,"preserve me");
});

test("the real selected dependency installer registers the professional source for an unrelated consumer project", async t => {
  const f = await fixture(t);
  const result = child(f, `
    import fs from 'node:fs';
    import path from 'node:path';
    import {spawnSync} from 'node:child_process';
    import {discoverDependencyAgentContracts} from ${JSON.stringify(moduleUrl("scripts/dependency-agent-discovery.mjs"))};
    const home=${JSON.stringify(f.home)},source=${JSON.stringify(f.source)};
    const env={...process.env,META_KIM_LOCAL_DEPENDENCY_ROOT:source,META_KIM_CODEX_HOME:path.join(home,'.codex'),META_KIM_SKIP_OPTIONAL_TOOLS:'1'};
    const installed=spawnSync(process.execPath,[${JSON.stringify(path.join(root, "scripts/install-global-skills-all-runtimes.mjs"))},'--targets','codex','--skills','findskill','--prefer-local-dependencies','--skip-plugins','--skip-inventory-refresh'],{cwd:${JSON.stringify(f.temporary)},env,encoding:'utf8',timeout:30000,windowsHide:true});
    if(installed.status!==0)throw new Error(installed.stdout+'\\n'+installed.stderr);
    const consumer=path.join(home,'separate business project');fs.mkdirSync(consumer);
    const discovered=await discoverDependencyAgentContracts({projects:[${JSON.stringify(project)}],projectRoot:consumer,environment:process.env});
    console.log(JSON.stringify({installed:fs.existsSync(path.join(home,'.codex/skills/findskill/SKILL.md')),agents:discovered.agents.map(a=>a.id),binding:discovered.sources[0].rootBinding,projectConfigCreated:fs.existsSync(path.join(consumer,'.meta-kim/local.overrides.json'))}));
  `);
  assert.equal(result.installed, true);
  assert.deepEqual(result.agents, ["kim-service:example-engineer"]);
  assert.equal(result.binding, "install-manifest.json#kim-service-dependency-source");
  assert.equal(result.projectConfigCreated, false);
});
