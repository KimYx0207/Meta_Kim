import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { directoryClosureSync } from '../../../scripts/install-manifest.mjs';
import { renderDesktopSkill } from './desktop-skill-renderers.mjs';
import { desktopSkillZip } from './desktop-skill-zip.mjs';

const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const configFile = new URL('../../../config/desktop-hosts.json', import.meta.url);
const portable = value => value.split(path.sep).join('/');
const COMPONENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
function safeRelative(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 240 && !value.includes('\\'), 'Invalid package relative path');
  assert(value.split('/').every(part => part && part !== '.' && part !== '..' && !/[\x00-\x1f<>:"|?*]/u.test(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Unsafe package relative path');
  return value;
}
function plainPath(value, missing = false) {
  assert(path.isAbsolute(value), 'Use an explicit absolute path');
  const resolved = path.resolve(value); let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep)) {
    if (!part) continue; current = path.join(current, part);
    if (!fs.existsSync(current)) {
      // lstat catches dangling symbolic links that existsSync follows.
      try { assert(!fs.lstatSync(current).isSymbolicLink(), 'Symlinks/junctions are not supported'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert(missing, `Missing path: ${current}`); continue;
    }
    const stat = fs.lstatSync(current); assert(!stat.isSymbolicLink(), 'Symlinks/junctions are not supported');
    if (current !== resolved) assert(stat.isDirectory(), 'Path parent must be a directory');
  }
  return resolved;
}
function contained(parent, child) { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
function tree(root) {
  plainPath(root); const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name,'en'))) {
      const file = path.join(dir, entry.name), stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink(), 'Source/output links are not supported');
      assert(!['.git','node_modules','.env','.meta-kim'].includes(entry.name), 'Private/runtime directories must not enter a method package');
      if (stat.isDirectory()) walk(file); else { assert(stat.isFile() && stat.nlink === 1, 'Only ordinary unlinked files are supported'); files.push(file); }
    }
  }
  walk(root); return files;
}
function sourceSelection(root, kind, component) {
  assert(COMPONENT.test(component), 'Invalid component identifier');
  if (kind === 'meta') {
    assert.equal(component, 'meta-theory', 'Meta desktop export currently supports meta-theory');
    const manifest = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
    assert.equal(manifest.name,'meta-kim','Wrong Meta source root');
    return { id:'meta-theory', displayName:'Meta_Kim 元理论', description:'按当前任务加载完整治理方法、职责和核验标准；能力不足时保留明确缺口。', displayNameEn:'Meta_Kim task governance', descriptionEn:'Understand intent, discover available capabilities, assign bounded work, review evidence and preserve unfinished tasks across sessions. This is method guidance, not an installed execution runtime.', version:manifest.version, entrypoint:'canonical/skills/meta-theory/SKILL.md', selections:['canonical/skills/meta-theory','canonical/agents','config'], contract:null };
  }
  assert.equal(kind,'service','Unknown source kind');
  const matches = ['agents','skills'].map(type => `${type}/${component}`).filter(rel => fs.existsSync(path.join(root,rel,'capability.json')));
  assert.equal(matches.length,1,'Select one unambiguous canonical Agent or Skill');
  const relative = matches[0], contract = JSON.parse(fs.readFileSync(plainPath(path.join(root,relative,'capability.json')),'utf8'));
  assert.equal(contract.id,component); assert(['agent','skill'].includes(contract.componentType));
  assert.equal(relative.split('/')[0],contract.componentType==='agent'?'agents':'skills');
  const entrypoint = `${relative}/${safeRelative(contract.entrypoint)}`;
  assert(fs.statSync(plainPath(path.join(root,entrypoint))).isFile(),'Component entrypoint is missing');
  const translationsFile=path.join(root,'config/task-browser-capabilities.en.json');
  const translationBytes=fs.existsSync(translationsFile)?fs.readFileSync(plainPath(translationsFile)):null;
  const translations=translationBytes?JSON.parse(translationBytes).capabilities:{};
  const english=contract.capabilities.map(item=>translations[item.id]).filter((item,index)=>item&&item.sourceSummary===contract.capabilities[index].summary);
  const catalogFile=path.join(root,'catalog.json');
  const catalog=fs.existsSync(catalogFile)?JSON.parse(fs.readFileSync(plainPath(catalogFile),'utf8')):null;
  const componentOrigin=catalog?.components?.find(item=>item.id===component);
  return { id:`kim-${component}`, displayNameEn:english[0]?.title, descriptionEn:english.length?english.map(item=>item.summary).join(' ').slice(0,450):undefined, translationSha256:translationBytes?hash(translationBytes):null, componentSourceRevision:componentOrigin?.revision??null, displayName:`Kim Service · ${component}`, description:contract.capabilities.map(item=>item.summary).join(' ').slice(0,450), version:contract.componentVersion, entrypoint, selections:[relative], contract };
}

function sourceIdentity(root, kind, sourceRecord) {
  const repository=kind==='meta'?'KimYx0207/Meta_Kim':'KimYx0207/Kim_Service';
  const releaseVersion=kind==='meta'?JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version:fs.readFileSync(path.join(root,'VERSION'),'utf8').trim();
  let gitHead=null, workingTreeClean=null;
  if(fs.existsSync(path.join(root,'.git'))) {
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT'].includes(key.toUpperCase())));
    Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_OPTIONAL_LOCKS:'0'});
    const git=args=>execFileSync('git',['-c','core.fsmonitor=false','--no-optional-locks','-C',root,...args],{env,encoding:'utf8',timeout:15000,maxBuffer:1024*1024}).trim();
    assert.equal(path.relative(root,path.resolve(git(['rev-parse','--show-toplevel']))),'','Source Git root differs');
    gitHead=git(['rev-parse','HEAD']); assert(/^[a-f0-9]{40}$/.test(gitHead),'Invalid source Git revision');
    workingTreeClean=git(['status','--porcelain=v1','--untracked-files=all']).length===0;
  }
  let releaseRecord=null;
  if(sourceRecord) {
    const bytes=fs.readFileSync(plainPath(sourceRecord));assert(bytes.length<=8192,'Source record too large');
    const lines=bytes.toString('utf8').trim().split(/\r?\n/);const commit=/^commit ([a-f0-9]{40})$/.exec(lines[2]??'');
    assert.equal(lines[0],repository,'Source record repository mismatch');assert.equal(lines[1],kind==='meta'?`v${releaseVersion}`:releaseVersion,'Source record version mismatch');assert(commit,'Source record commit missing');
    if(gitHead)assert.equal(commit[1],gitHead,'Source record and Git HEAD differ');
    releaseRecord={sha256:hash(bytes),declaredCommit:commit[1],authority:'caller_supplied_release_record_not_archive_authentication'};
  }
  return {repository,releaseVersion,gitHead,workingTreeClean,releaseRecord,commitAuthority:gitHead?'git_head_plus_actual_file_hashes':'unavailable_source_archive_use_actual_file_hashes'};
}

/** Export one method as a host-importable Skill. Never writes host config or
 * installs anything. Existing output is immutable; --check is read-only. */
export function buildDesktopSkillPackage({ host, kind, sourceRoot, component, output, sourceRecord, check = false }) {
  const hosts = JSON.parse(fs.readFileSync(configFile,'utf8')).hosts;
  assert(Object.hasOwn(hosts,host),'Unknown desktop host'); const hostContract = hosts[host];
  const root = plainPath(sourceRoot), destination = plainPath(output,true);
  assert(fs.statSync(root).isDirectory(),'Source root must be a directory');
  assert(!contained(root,destination) && !contained(destination,root),'Output must not overlap the source');
  assert(fs.statSync(plainPath(path.dirname(destination))).isDirectory(),'Output parent must exist');
  const metadata = { ...sourceSelection(root,kind,component), kind };
  assert(COMPONENT.test(metadata.id),'Generated skill identifier exceeds the supported portable format');
  const files = new Map(), modes = new Map(), sourceClosures = [], sources = [];
  const { limits } = hostContract;
  let total = 0;
  function add(relative,bytes,mode = 0o644) {
    safeRelative(relative); assert(!files.has(relative),'Duplicate package path');
    assert(bytes.length <= limits.fileBytes, `File exceeds ${host} export limit: ${relative}`);
    total += bytes.length; assert(total <= limits.unpackedBytes,`${host} unpacked size limit exceeded`);
    assert(files.size + 1 <= limits.entries,`${host} file count limit exceeded`); files.set(relative,bytes); modes.set(relative,mode);
  }
  for (const relative of metadata.selections) {
    const folder = plainPath(path.join(root,relative)); const before = directoryClosureSync(folder); assert(before,'Cannot hash source closure');
    for (const file of tree(folder)) { const rel=portable(path.relative(root,file)); const bytes=fs.readFileSync(file); add(`source/${rel}`,bytes,fs.statSync(file).mode & 0o111 ? 0o755 : 0o644); sources.push({path:rel,size:bytes.length,sha256:hash(bytes)}); }
    assert.deepEqual(directoryClosureSync(folder),before,'Source changed during export'); sourceClosures.push({path:relative,...before});
  }
  const extras = ['LICENSE','NOTICE',...(kind==='service'?['VERSION']:[])];
  if (kind==='service' && fs.existsSync(path.join(root,'catalog.json'))) {
    for(const asset of JSON.parse(fs.readFileSync(plainPath(path.join(root,'catalog.json')),'utf8')).assets ?? []) {
      assert(/^docs\/images\/[^/\\]+\.(?:png|jpe?g|webp|gif|svg)$/iu.test(asset.path),'Invalid declared public asset'); extras.push(asset.path);
    }
  }
  for(const relative of extras) {
    const file=plainPath(path.join(root,relative)); const stat=fs.lstatSync(file);assert(stat.isFile()&&stat.nlink===1,'Expected ordinary resource');
    const bytes=fs.readFileSync(file);add(`source/${relative}`,bytes);sources.push({path:relative,size:bytes.length,sha256:hash(bytes)});
  }
  const exporterVersion=JSON.parse(fs.readFileSync(new URL('../../../package.json',import.meta.url),'utf8')).version;
  const exporterFiles=['desktop-skill-package.mjs','desktop-skill-renderers.mjs','desktop-skill-zip.mjs'];
  const exporter={version:exporterVersion,implementationSha256:Object.fromEntries(exporterFiles.map(name=>[name,hash(fs.readFileSync(new URL(name,import.meta.url)))])),hostContractSha256:hash(fs.readFileSync(configFile))};
  const source=sourceIdentity(root,kind,sourceRecord);
  let dependencyBinding=null;
  if(kind==='service') {
    const releaseFile=path.join(root,'.github/release.json');
    const requiredMeta=fs.existsSync(releaseFile)?JSON.parse(fs.readFileSync(plainPath(releaseFile),'utf8')).metaRelease:null;
    if(requiredMeta)assert.equal(`v${exporterVersion}`,requiredMeta,'Service requires a different Meta exporter version');
    const expected=JSON.parse(fs.readFileSync(new URL('../../../config/dependency-baseline.json',import.meta.url),'utf8')).kimService.commit;
    const observed=source.gitHead??source.releaseRecord?.declaredCommit??null;
    if(observed)assert.equal(observed,expected,'Service source commit differs from Meta dependency baseline');
    dependencyBinding={requiredMetaVersion:requiredMeta,exporterVersion,expectedServiceCommit:expected,observedServiceCommit:observed,commitMatches:observed?true:null,sourceBytesBoundToCommit:Boolean(source.gitHead&&source.workingTreeClean),basis:source.gitHead?'git_head_and_worktree_status':source.releaseRecord?'caller_supplied_record_only':'content_hash_only_pin_unverified'};
  }
  const provenance = { schemaVersion:1, exporter, source, dependencyBinding, componentSourceRevision:metadata.componentSourceRevision??null, componentSourceRevisionAuthority:metadata.componentSourceRevision?'catalog_record_actual_bytes_separately_hashed':null, translationSha256:metadata.translationSha256??null, host, deliveryMode:hostContract.deliveryMode, kind, component, componentType:metadata.contract?.componentType??'governance_skill', version:metadata.version, entrypoint:`source/${metadata.entrypoint}`, sourceClosures, sourceFiles:sources, officialSources:hostContract.officialSources, sourceDiscoveryPaths:{user:hostContract.userDiscoveryPath,project:hostContract.projectDiscoveryPath}, runtimeIncluded:false, installed:false, nativeAgentRegistered:false, nativeInvocationVerified:false, nativeExecutionVerified:false };
  add('SKILL.md',Buffer.from(renderDesktopSkill(hostContract,metadata)));
  add('package-provenance.json',json(provenance));
  const archive = desktopSkillZip(files,metadata.id,modes); assert(archive.length<=limits.archiveBytes,`${host} ZIP size limit exceeded`);
  const manifest = { ...provenance, status:'exported_not_installed', archive:{path:`${metadata.id}.zip`,size:archive.length,sha256:hash(archive)}, files:[...files].map(([file,bytes])=>({path:`${metadata.id}/${file}`,size:bytes.length,sha256:hash(bytes),mode:modes.get(file)})) };
  const expected = new Map([...files].map(([file,bytes])=>[`${metadata.id}/${file}`,bytes]));expected.set(`${metadata.id}.zip`,archive);expected.set('desktop-package.json',json(manifest));
  if(check) {
    assert.deepEqual(tree(destination).map(file=>portable(path.relative(destination,file))).sort(),[...expected.keys()].sort(),'Package file closure differs');
    for(const [file,bytes]of expected)assert(fs.readFileSync(path.join(destination,file)).equals(bytes),`Package changed: ${file}`);
    return {...manifest,status:'verified_export_not_installed'};
  }
  assert(!fs.existsSync(destination),'Output exists; choose a new directory or use --check. User files are never replaced.');
  const stage=path.join(path.dirname(destination),`.desktop-skill-${randomUUID()}`);fs.mkdirSync(stage);
  try {
    for(const [file,bytes]of expected){const target=path.join(stage,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx',mode:modes.get(file.slice(metadata.id.length+1))??0o644});}
    plainPath(path.dirname(destination));assert(!fs.existsSync(destination),'Output appeared concurrently');fs.renameSync(stage,destination);
  }finally{if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true,force:true});}
  return manifest;
}
