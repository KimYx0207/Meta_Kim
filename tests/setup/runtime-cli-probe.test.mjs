import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { probeRuntimeCli, runtimeCliProbeEligibility } from "../../scripts/runtime-cli-probe.mjs";
import { resolveTargetContext } from "../../scripts/meta-kim-sync-config.mjs";
import { resolveWindowsCliLaunchDescriptor } from "../../scripts/runtime-cli-invocation.mjs";
import { runRuntimeCliVersion } from "../../scripts/runtime-cli-version.mjs";
import { NATIVE_PROJECTION_RUNTIME_IDS } from "../../scripts/native-runtime-projection.mjs";

function fixture(t) {
  const root=mkdtempSync(path.join(os.tmpdir(),"meta-cli-probe-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const bin=path.join(root,"中文 CLI Space");mkdirSync(bin);
  return {root,bin};
}

function nodeCli(bin,name,source) {
  const entry=path.join(bin,`${name}.js`);writeFileSync(entry,source);
  if(process.platform==="win32") {
    const shim=path.join(bin,`${name}.cmd`);
    writeFileSync(shim,`@"%~dp0\\${name}.js" %*\r\n`);
    return shim;
  }
  const launcher=path.join(bin,name);
  writeFileSync(launcher,`#!${process.execPath}\n${source}`);chmodSync(launcher,0o755);
  return launcher;
}
// Fixture budgets measure lookup and execution in a declared test environment;
// inherited Windows/network directories belong to the separate live PATH check.
const locatorDirectories=process.platform==="win32"
  ? [path.join(process.env.SystemRoot,"System32")] : ["/usr/bin","/bin"];
const envFor=bin=>({...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^path$/iu.test(key))),
  PATH:[bin,...locatorDirectories].join(path.delimiter)});

test("a real CLI in a Unicode path with spaces runs shell-free and reports its version", t=>{
  const {bin}=fixture(t);
  nodeCli(bin,"meta-probe-fixture","if(process.argv[2]!=='--version')process.exit(4);console.log('fixture 1.2.3');\n");
  const result=probeRuntimeCli("meta-probe-fixture",{env:envFor(bin),timeoutMs:8000});
  assert.equal(result.status,"detected");assert.equal(result.version,"fixture 1.2.3");
});

test("a native CLI mentioning Windows executables only in a comment still reports its version",t=>{
  const {bin}=fixture(t);
  nodeCli(bin,"meta-comment-fixture","// Windows documentation example: Cursor.exe --version\nconsole.log('native fixture 1');\n");
  assert.equal(probeRuntimeCli("meta-comment-fixture",{env:envFor(bin)}).version,"native fixture 1");
});

test("the shared version executor kills a real started hanging CLI at its explicit budget", t=>{
  const {bin,root}=fixture(t),marker=path.join(root,"actually-started");
  const cli=nodeCli(bin,"meta-hanging-fixture",`require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000);\n`);
  const descriptor=process.platform==="win32"?resolveWindowsCliLaunchDescriptor(cli):{launcher:cli,argsPrefix:[]};
  const started=Date.now(),result=runRuntimeCliVersion(descriptor.launcher,[...descriptor.argsPrefix,"--version"],descriptor,{timeoutMs:1500});
  assert.equal(result.status,null);assert.equal(result.error?.code,"ETIMEDOUT");
  assert.ok(Date.now()-started<5000,"The real child must be terminated within a bounded interval");
  assert.equal(readFileSync(marker,"utf8"),"started");
});

test("the overall probe deadline also bounds PATH location plus a hanging version command",t=>{
  const {bin}=fixture(t);nodeCli(bin,"meta-overall-deadline-fixture","setInterval(()=>{},1000);\n");
  const started=Date.now(),result=probeRuntimeCli("meta-overall-deadline-fixture",{env:envFor(bin),timeoutMs:1500});
  assert.equal(result.status,"unprobed");assert.equal(result.reason,"timeout");assert.equal(result.version,null);
  assert.ok(Date.now()-started<5000);
});

test("an absent CLI remains unprobed without invoking a shell", ()=>{
  const result=probeRuntimeCli("meta-missing-cli-946025",{env:envFor(path.dirname(process.execPath)),timeoutMs:8000});
  assert.equal(result.status,"not_found");assert.equal(result.version,null);
  assert.throws(()=>probeRuntimeCli("cursor; echo injected"),/simple command/);
});

test("POSIX rejects real PE bytes and Windows launcher scripts without relying on WSL environment variables", t=>{
  const {bin}=fixture(t),binary=path.join(bin,"disguised-cursor"),script=path.join(bin,"cursor");
  writeFileSync(binary,Buffer.from([0x4d,0x5a,0,0]));
  writeFileSync(script,"#!/bin/sh\nexec /mnt/c/Apps/Cursor.exe --version\n");
  for(const platform of ["linux","darwin"]) {
    assert.equal(runtimeCliProbeEligibility(binary,{platform}).reason,"windows_executable_on_posix");
    assert.equal(runtimeCliProbeEligibility(script,{platform}).reason,"windows_launcher_on_posix");
  }
  writeFileSync(script,'#!/bin/sh\n# echo example.exe\necho "Help: example.exe"\nAPP="/mnt/c/Program Files/Cursor.exe"\nELECTRON_RUN_AS_NODE=1 "$APP" --version\n');
  assert.equal(runtimeCliProbeEligibility(script,{platform:"linux"}).reason,"windows_launcher_on_posix");
  writeFileSync(script,'#!/bin/sh\n# exec example.exe\necho "Help: example.exe"\nprintf "example.exe"\n');
  assert.equal(runtimeCliProbeEligibility(script,{platform:"linux",mountInfo:""}).eligible,true);
});

test("actual resolved mount plus a Windows shim companion is rejected; a native Linux script remains eligible", t=>{
  const {bin}=fixture(t),script=path.join(bin,"cursor");
  writeFileSync(script,"#!/bin/sh\nexec node cli.js \"$@\"\n");writeFileSync(script+".cmd","@node cli.js %*\n");
  const physical=realpathSync(bin).replaceAll("\\","/"),mount=physical.replaceAll(" ","\\040");
  const mountInfo=`42 1 0:25 / ${mount} rw - 9p drvfs rw,aname=drvfs;path=C:\\;uid=1000\n`;
  // The lexical Windows test exercises mount parsing; real Linux CI/WSL also
  // supplies the actual /proc mount inventory through the production default.
  if(process.platform!=="win32") {
    assert.equal(runtimeCliProbeEligibility(script,{platform:"linux",mountInfo}).reason,"windows_mounted_shim");
  }
  assert.equal(runtimeCliProbeEligibility(script,{platform:"linux",mountInfo:""}).eligible,true);
});

test("Windows PE GUI applications cannot become CLI probes; console binaries can", t=>{
  const {bin}=fixture(t),binary=path.join(bin,"cursor.exe"),bytes=Buffer.alloc(256);
  bytes.write("MZ");bytes.writeUInt32LE(64,60);bytes.write("PE\0\0",64);bytes.writeUInt16LE(2,64+24+68);writeFileSync(binary,bytes);
  assert.equal(runtimeCliProbeEligibility(binary,{platform:"win32"}).reason,"gui_executable");
  bytes.writeUInt16LE(3,64+24+68);writeFileSync(binary,bytes);
  assert.equal(runtimeCliProbeEligibility(binary,{platform:"win32"}).eligible,true);
  writeFileSync(binary,"MZ");assert.equal(runtimeCliProbeEligibility(binary,{platform:"win32"}).eligible,false);
});

test("Linux skips an inherited Windows launcher and finds the later native CLI on the actual PATH", {skip:process.platform!=="linux"}, t=>{
  const {root,bin}=fixture(t),windows=path.join(root,"Windows Shim");mkdirSync(windows);
  const marker=path.join(root,"must-not-run");
  writeFileSync(path.join(windows,"meta-probe-fixture"),`#!/bin/sh\ntouch '${marker}'\nexec '/mnt/c/Apps/Cursor.exe' --version\n`);chmodSync(path.join(windows,"meta-probe-fixture"),0o755);
  nodeCli(bin,"meta-probe-fixture","console.log('native Linux 1');\n");
  const result=probeRuntimeCli("meta-probe-fixture",{env:envFor(windows+path.delimiter+bin)});
  assert.equal(result.version,"native Linux 1");
  assert.throws(()=>readFileSync(marker),{code:"ENOENT"});
});

test("Windows resolves a real native console CLI before version invocation", {skip:process.platform!=="win32"}, t=>{
  const {bin}=fixture(t);copyFileSync(process.execPath,path.join(bin,"meta-native-fixture.exe"));
  const result=probeRuntimeCli("meta-native-fixture",{env:envFor(bin)});
  assert.equal(result.version,process.version);
});

test("setup delegates only runtime version discovery to the bounded probe",()=>{
  const source=readFileSync(new URL("../../setup.mjs",import.meta.url),"utf8");
  const body=source.slice(source.indexOf("function detectCli("),source.indexOf("function gitProxyArgs("));
  assert.match(body,/probeRuntimeCli\(name/);assert.doesNotMatch(body,/\brun\(|execSync/);
});

test("setup keeps all detected flags false but provisions explicit supported targets when every probe is unavailable", async()=>{
  const source=readFileSync(new URL("../../setup.mjs",import.meta.url),"utf8");
  const body=source.slice(source.indexOf("async function detectRuntimes("),source.indexOf("function detectedTargetIds("));
  for(const args of [["--targets","codex"],[],["--targets","unsupported-runtime"]]) {
    let asked=0;
    const context={args,resolveTargetContext,heading(){},detectCli:()=>null,skip(){},warn(){},
      NATIVE_PROJECTION_RUNTIME_IDS,setupRuntimeProfiles:{gemini:{label:"Gemini CLI"},zcode:{label:"ZCode"}},
      t:{},C:{yellow:"",reset:"",dim:""},console:{log(){}},fmt:()=>"",DISTRIBUTION:{documentation:{claudeCode:"fixture"}},
      askYesNo:async()=>{asked++;return false;},process:{exit:()=>{throw new Error("setup cancelled");}}};
    const run=vm.runInNewContext(`(${body})()`,context);
    if(args[1]==="codex") {
      assert.deepEqual(JSON.parse(JSON.stringify(await run)),{claude:false,codex:false,openclaw:false,cursor:false,gemini:false,zcode:false});
      assert.equal(asked,0);
    } else if(args.length===0) {
      await assert.rejects(run,/setup cancelled/);assert.equal(asked,1);
    } else {
      await assert.rejects(run,/Unknown runtime target/);assert.equal(asked,0);
    }
  }
});
