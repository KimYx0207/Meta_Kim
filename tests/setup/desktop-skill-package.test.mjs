import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {buildDesktopSkillPackage} from '../../src/infrastructure/distribution/desktop-skill-package.mjs';
import {renderDesktopSkill} from '../../src/infrastructure/distribution/desktop-skill-renderers.mjs';
function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-method-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=path.join(base,'source'),component=path.join(root,'skills','example');fs.mkdirSync(path.join(component,'scripts'),{recursive:true});
  for(const name of ['LICENSE','NOTICE','VERSION'])fs.writeFileSync(path.join(root,name),name==='VERSION'?'V1.16\n':name+'\n');
  fs.writeFileSync(path.join(component,'capability.json'),JSON.stringify({id:'example',componentType:'skill',componentVersion:'1.0.0',entrypoint:'SKILL.md',capabilities:[{summary:'Example method'}]}));
  fs.writeFileSync(path.join(component,'SKILL.md'),'---\nname: example\ndescription: Original\n---\nRead scripts/run.mjs.\n');
  fs.writeFileSync(path.join(component,'scripts/run.mjs'),'console.log("actual portable result");\n');
  return {base,root,component,options:{host:'workbuddy',kind:'service',sourceRoot:root,component:'example',output:path.join(base,'output')}};
}
test('export preserves complete methods and executable bytes; deterministic readback catches drift',t=>{
  const f=fixture(t),report=buildDesktopSkillPackage(f.options);
  assert.equal(report.installed,false);assert.equal(report.nativeExecutionVerified,false);assert.equal(report.nativeAgentRegistered,false);
  const skill=path.join(f.options.output,'kim-example');
  assert.equal(fs.readFileSync(path.join(skill,'source/skills/example/SKILL.md'),'utf8'),fs.readFileSync(path.join(f.component,'SKILL.md'),'utf8'));
  const executed=spawnSync(process.execPath,[path.join(skill,'source/skills/example/scripts/run.mjs')],{encoding:'utf8'});assert.equal(executed.status,0);assert.equal(executed.stdout.trim(),'actual portable result');
  const wrapper=fs.readFileSync(path.join(skill,'SKILL.md'),'utf8');for(const field of ['display_name:','display_name_en:','description_zh:','description_en:','version:','author:'])assert(wrapper.includes(field));
  assert.equal(buildDesktopSkillPackage({...f.options,check:true}).status,'verified_export_not_installed');
  const second=buildDesktopSkillPackage({...f.options,output:path.join(f.base,'second')});assert.equal(second.archive.sha256,report.archive.sha256);
  assert.throws(()=>buildDesktopSkillPackage(f.options),/Output exists/);
  fs.appendFileSync(path.join(skill,'source/skills/example/SKILL.md'),'user change');
  assert.throws(()=>buildDesktopSkillPackage({...f.options,check:true}),/Package changed/);
  assert(fs.readFileSync(path.join(skill,'source/skills/example/SKILL.md'),'utf8').endsWith('user change'));
});
test('unsafe identities, unknown hosts, output overlap and dangling output links fail without writes',t=>{
  const f=fixture(t);for(const changes of [{component:'../example'},{host:'unverified-host'},{output:path.join(f.root,'output')}])assert.throws(()=>buildDesktopSkillPackage({...f.options,...changes}));
  assert(!fs.existsSync(f.options.output));
  if(process.platform!=='win32'){fs.symlinkSync(path.join(f.base,'missing'),f.options.output);assert.throws(()=>buildDesktopSkillPackage(f.options),/Symlinks/);}
});
test('linked resources and absent closure members never yield a partial package',t=>{
  const f=fixture(t);fs.unlinkSync(path.join(f.root,'LICENSE'));assert.throws(()=>buildDesktopSkillPackage(f.options),/Missing path/);assert(!fs.existsSync(f.options.output));
  fs.writeFileSync(path.join(f.root,'LICENSE'),'license');
  if(process.platform!=='win32'){fs.symlinkSync(path.join(f.root,'LICENSE'),path.join(f.component,'linked'));assert.throws(()=>buildDesktopSkillPackage(f.options),/links/);assert(!fs.existsSync(f.options.output));}
});
test('oversized content is rejected before publishing any output',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.component,'oversize.bin'),Buffer.alloc(8388609));assert.throws(()=>buildDesktopSkillPackage(f.options),/File exceeds/);assert(!fs.existsSync(f.options.output));
});
test('Doubao uses portable metadata and never adopts enterprise plugin requirements',()=>{
  const text=renderDesktopSkill({renderer:'doubao',displayName:'Doubao'},{id:'example',displayName:'示例',description:'selected method',version:'1.0.0',entrypoint:'skills/example/SKILL.md',kind:'service'});
  assert.match(text,/metadata:\n  version: "1.0.0"\n  source: "KimYx0207\/Kim_Service"/);assert.doesNotMatch(text,/openapi|widgets|expertType/);
});
test('source records cannot relabel a release or bypass the exact Service dependency pin',t=>{
  const f=fixture(t),record=path.join(f.base,'SOURCE-REVISION.txt');
  fs.writeFileSync(record,'KimYx0207/Kim_Service\nV0.0\ncommit '+ 'a'.repeat(40)+'\n');
  assert.throws(()=>buildDesktopSkillPackage({...f.options,sourceRecord:record}),/version mismatch/);
  fs.writeFileSync(record,'KimYx0207/Kim_Service\nV1.16\ncommit '+ 'a'.repeat(40)+'\n');
  assert.throws(()=>buildDesktopSkillPackage({...f.options,sourceRecord:record}),/dependency baseline/);
  assert(!fs.existsSync(f.options.output));
});
test('Doubao per-file limits are enforced without truncating resources',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.component,'too-large.bin'),Buffer.alloc(2097153));
  assert.throws(()=>buildDesktopSkillPackage({...f.options,host:'doubao'}),/File exceeds doubao/);assert(!fs.existsSync(f.options.output));
});
test('unknown user additions are preserved and make read-only check fail',t=>{
  const f=fixture(t);buildDesktopSkillPackage(f.options);const extra=path.join(f.options.output,'my-note.txt');fs.writeFileSync(extra,'user note');
  assert.throws(()=>buildDesktopSkillPackage({...f.options,check:true}),/closure differs/);assert.equal(fs.readFileSync(extra,'utf8'),'user note');
});
