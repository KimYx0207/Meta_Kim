import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordSetupRuntimeExecutableBindings } from "../../scripts/runtime-executable-binding.mjs";

function fixture(t) {
  const root=mkdtempSync(path.join(os.tmpdir(),"meta-binding-probe-")),bin=path.join(root,"CLI Space");mkdirSync(bin);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return {root,bin,inventory:path.join(root,".meta-kim/state/default/runtime-capability-producers/host-executable-bindings.json")};
}
function nodeCli(bin,source) {
  if(process.platform==="win32") {
    writeFileSync(path.join(bin,"codex.js"),source);
    const shim=path.join(bin,"codex.cmd");writeFileSync(shim,'@"%~dp0\\codex.js" %*\r\n');return shim;
  }
  const cli=path.join(bin,"codex");writeFileSync(cli,`#!${process.execPath}\n${source}`);chmodSync(cli,0o755);return cli;
}
function record(root,candidate) {
  // Only location is supplied by the fixture. The actual default version
  // runner, eligibility inspection, hashing and inventory writer remain live.
  return recordSetupRuntimeExecutableBindings({roots:[root],targets:["codex"],pathResolver:()=>[candidate]});
}

test("default binding kills a real hanging version CLI and writes no available inventory",t=>{
  const f=fixture(t),marker=path.join(f.root,"started");
  const cli=nodeCli(f.bin,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000);\n`);
  const start=Date.now();assert.throws(()=>record(f.root,cli),/ETIMEDOUT|timed out|without status/);
  assert.ok(Date.now()-start<15000,"The production default version runner must terminate its child");
  assert.equal(readFileSync(marker,"utf8"),"started");assert.equal(existsSync(f.inventory),false);
});

test("default binding records a real healthy CLI without treating Windows documentation as a launcher",t=>{
  const f=fixture(t),cli=nodeCli(f.bin,"// Windows example: Cursor.exe --version\nconsole.log('fixture-cli 3.0.0');\n");
  const result=record(f.root,cli);
  assert.equal(result.bindings.codex.version,"fixture-cli 3.0.0");
  assert.equal(existsSync(f.inventory),true);
  assert.equal(result.executionAuthority,false);
});

test("default binding rejects actual Windows PE bytes on POSIX and Windows GUI executables on Windows",t=>{
  const f=fixture(t),file=path.join(f.bin,"codex.exe"),bytes=Buffer.alloc(256);
  bytes.write("MZ");bytes.writeUInt32LE(64,60);bytes.write("PE\0\0",64);bytes.writeUInt16LE(2,64+24+68);writeFileSync(file,bytes);
  assert.throws(()=>record(f.root,file),process.platform==="win32"?/gui_executable/:/windows_executable_on_posix/);
  assert.equal(existsSync(f.inventory),false);
});

test("default POSIX binding never starts a Windows launcher or writes an available inventory",{skip:process.platform==="win32"},t=>{
  const f=fixture(t),marker=path.join(f.root,"must-not-run"),cli=path.join(f.bin,"codex");
  writeFileSync(cli,`#!/bin/sh\ntouch '${marker}'\nAPP='/mnt/c/Program Files/Cursor.exe'\nexec "$APP" --version\n`);chmodSync(cli,0o755);
  assert.throws(()=>record(f.root,cli),/windows_launcher_on_posix/);
  assert.equal(existsSync(marker),false);assert.equal(existsSync(f.inventory),false);
});
