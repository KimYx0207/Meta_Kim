import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { resolveRuntimeHomeInfo, resolveRuntimeHomeDir } from '../../scripts/meta-kim-sync-config.mjs';
import { mockEnv } from './_mocks.mjs';
const runtimes=['claude','codex','cursor','openclaw','qoder'];
const keys=runtimes.flatMap(r=>['META_KIM_'+r.toUpperCase()+'_HOME',r.toUpperCase()+'_HOME']).concat('CLAUDE_CONFIG_DIR');
function withEnv(values, action){const restore=mockEnv({...Object.fromEntries(keys.map(k=>[k,''])),...values});try{return action();}finally{restore();}}
describe('actual runtime home resolver',()=>{
 for(const runtime of runtimes){
  test(runtime+' uses the actual host home fallback',()=>withEnv({},()=>{
   assert.deepEqual(resolveRuntimeHomeInfo(runtime),{dir:path.join(os.homedir(),'.'+runtime),source:'default'});
   assert.equal(resolveRuntimeHomeDir(runtime),path.join(os.homedir(),'.'+runtime));
  }));
  test(runtime+' honors native directory and Meta override',()=>{
   const nativeKey=runtime.toUpperCase()+'_HOME',metaKey='META_KIM_'+runtime.toUpperCase()+'_HOME';
   const native=path.join(os.tmpdir(),'Native Home',runtime),override=path.join(os.tmpdir(),'Meta Home',runtime);
   withEnv({[nativeKey]:native},()=>assert.deepEqual(resolveRuntimeHomeInfo(runtime),{dir:native,source:'env:'+nativeKey}));
   withEnv({[nativeKey]:native,[metaKey]:'  '+override+'  '},()=>assert.deepEqual(resolveRuntimeHomeInfo(runtime),{dir:override,source:'env:'+metaKey}));
  });
 }
 test('Claude native CLAUDE_CONFIG_DIR wins over the legacy alias',()=>withEnv({CLAUDE_CONFIG_DIR:path.join(os.tmpdir(),'native-claude'),CLAUDE_HOME:path.join(os.tmpdir(),'legacy-claude')},()=>{
  assert.deepEqual(resolveRuntimeHomeInfo('claude'),{dir:path.join(os.tmpdir(),'native-claude'),source:'env:CLAUDE_CONFIG_DIR'});
 }));
 test('Meta override wins over both native and legacy Claude directories',()=>withEnv({META_KIM_CLAUDE_HOME:path.join(os.tmpdir(),'meta-claude'),CLAUDE_CONFIG_DIR:path.join(os.tmpdir(),'native-claude'),CLAUDE_HOME:path.join(os.tmpdir(),'legacy-claude')},()=>{
  assert.equal(resolveRuntimeHomeInfo('claude').source,'env:META_KIM_CLAUDE_HOME');
 }));
 test('whitespace declarations fall through and relative values use the caller cwd',()=>withEnv({META_KIM_CLAUDE_HOME:'  ',CLAUDE_CONFIG_DIR:'  runtime vault/claude  '},()=>{
  assert.deepEqual(resolveRuntimeHomeInfo('claude'),{dir:path.resolve('runtime vault/claude'),source:'env:CLAUDE_CONFIG_DIR'});
 }));
 test('unknown runtime identifiers are rejected by the real resolver',()=>{
  assert.throws(()=>resolveRuntimeHomeDir('unknown'),/Unknown runtime/);
 });
 for(const [platform,home] of [['darwin','/Users/portable-fixture'],['linux','/home/portable-fixture']]){
  test(platform+' logical path behavior uses the real resolver without drive assumptions',(t)=>{
   let actual,expected;
   withEnv({},()=>{t.mock.method(os,'homedir',()=>home);t.mock.method(path,'join',path.posix.join);try{actual=resolveRuntimeHomeInfo('codex');expected={dir:home+'/.codex',source:'default'};}finally{t.mock.restoreAll();}});
   assert.deepEqual(actual,expected);
   withEnv({CLAUDE_CONFIG_DIR:' /Volumes/Portable Space/claude '},()=>{t.mock.method(path,'resolve',path.posix.resolve);try{actual=resolveRuntimeHomeInfo('claude');}finally{t.mock.restoreAll();}});
   assert.deepEqual(actual,{dir:'/Volumes/Portable Space/claude',source:'env:CLAUDE_CONFIG_DIR'});
  });
 }
});
