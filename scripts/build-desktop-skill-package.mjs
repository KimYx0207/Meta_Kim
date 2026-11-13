#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildDesktopSkillPackage} from '../src/infrastructure/distribution/desktop-skill-package.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function runDesktopSkillCli(argv=process.argv.slice(2),{kind='meta',sourceRoot=ROOT}={}) {
  if(!argv.length||argv.includes('--help')) { console.log('node scripts/build-desktop-skill-package.mjs --host workbuddy|doubao --component ID --output /absolute/new-directory [--source-record /absolute/SOURCE-REVISION.txt] [--check]\nExport one complete Agent/Skill method for manual desktop Skill import. Meta component: meta-theory. Existing output and host configuration are never overwritten. No native installation or model call.');return; }
  const options={kind,sourceRoot};
  for(let i=0;i<argv.length;i++){
    const flag=argv[i];if(flag==='--check'){if(options.check)throw new Error('Duplicate --check');options.check=true;continue;}
    const key={'--host':'host','--component':'component','--output':'output','--source-record':'sourceRecord'}[flag];
    if(!key||options[key]!==undefined||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error(`Unknown, duplicate or incomplete argument: ${flag}`);
    options[key]=argv[++i];
  }
  if(!options.host||!options.component||!options.output)throw new Error('--host, --component and --output are required');
  const report=buildDesktopSkillPackage(options);
  console.log(JSON.stringify({status:report.status,host:report.host,component:report.component,version:report.version,archive:report.archive,fileCount:report.files.length,installed:false,nativeExecutionVerified:false},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{runDesktopSkillCli();}catch(error){console.error(`Desktop Skill export: ${error.message}`);process.exitCode=1;}}
