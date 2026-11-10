import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CALCULATION_PROCESS_MAX_OUTPUT_BYTES, CALCULATION_PROCESS_TIMEOUT_MS,
  runCalculationProcess } from "../../scripts/governed-execution/calculation-process.mjs";

const run = (source, input = "") => runCalculationProcess({ command: process.execPath,
  args: ["-e", source], cwd: os.tmpdir(), env: process.env, input });

test("asynchronous calculation stdin preserves large UTF-8 bytes, sends EOF and leaves the host responsive", async () => {
  const input = "纸袋\n".repeat(50000);
  let hostAdvanced = false;
  const timer = setTimeout(() => { hostAdvanced = true; }, 1);
  const result = await run(`const {createHash}=require('node:crypto'); const chunks=[];
    process.stdin.on('data', chunk=>chunks.push(chunk));
    process.stdin.on('end', ()=>{const bytes=Buffer.concat(chunks);
      process.stdout.write(JSON.stringify({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));});`, input);
  clearTimeout(timer);
  assert.equal(hostAdvanced, true, "the transport must not block the host's event loop");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0); assert.equal(result.signal, null);
  assert.equal(result.stdinFinished, true); assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { bytes: Buffer.byteLength(input),
    sha256: createHash("sha256").update(input).digest("hex") });
});

test("calculation output accepts its exact limit and refuses combined stdout/stderr overflow", async () => {
  assert.equal(CALCULATION_PROCESS_MAX_OUTPUT_BYTES, 4 * 1024 * 1024);
  const exact = await run(`process.stdin.resume(); process.stdin.on('end', ()=>process.stdout.write(Buffer.alloc(${CALCULATION_PROCESS_MAX_OUTPUT_BYTES},120)));`);
  assert.equal(exact.error, undefined); assert.equal(exact.status, 0);
  assert.equal(Buffer.byteLength(exact.stdout), CALCULATION_PROCESS_MAX_OUTPUT_BYTES);
  const overflow = await run(`process.stdin.resume(); process.stdin.on('end', ()=>{
    process.stdout.write(Buffer.alloc(3*1024*1024,120)); process.stderr.write(Buffer.alloc(3*1024*1024,121));});`);
  assert.equal(overflow.error?.code, "ENOBUFS");
  assert.equal(overflow.timedOut, false);
  assert.equal(Buffer.byteLength(overflow.stdout) + Buffer.byteLength(overflow.stderr), CALCULATION_PROCESS_MAX_OUTPUT_BYTES);
});

test("calculation launch failure never claims a child process or a receipt", async () => {
  const result = await runCalculationProcess({ command: path.join(os.tmpdir(), `missing-calculation-python-${process.pid}`),
    args: [], cwd: os.tmpdir(), env: process.env, input: "{}" });
  assert.equal(result.pid, undefined);
  assert.equal(result.error?.code, "ENOENT");
  assert.equal(result.stdout, ""); assert.equal(result.timedOut, false);
});

test("early stdin closure cannot be successful; exit 2 still requires caller receipt validation", async () => {
  const source = code => `require('node:fs').closeSync(0); process.stdout.write('{"status":"invalid_input"}'); process.exitCode=${code};`;
  const input = "x".repeat(2 * 1024 * 1024);
  const success = await run(source(0), input);
  assert.equal(success.status, 0);
  assert.ok(success.error, "closed input must not be accepted as a completed calculation");
  assert.equal(success.stdinFinished, false);
  const rejected = await run(source(2), input);
  assert.equal(rejected.status, 2); assert.equal(rejected.signal, null);
  if (rejected.stdinErrorCode === "EPIPE") assert.equal(rejected.error, undefined);
  else assert.ok(rejected.error, "other stdin errors remain transport failures even on exit 2");
  assert.deepEqual(JSON.parse(rejected.stdout), { status: "invalid_input" });
});

test("unexpected signals remain failures even when stdout contains JSON", { skip: process.platform === "win32" }, async () => {
  const result = await run(`process.stdin.resume(); process.stdin.on('end', ()=>{
    process.stdout.write('{}'); process.kill(process.pid,'SIGTERM');});`);
  assert.equal(result.status, null); assert.equal(result.signal, "SIGTERM");
  assert.equal(result.timedOut, false);
});

test("the unchanged ten-second deadline terminates the child and never accepts partial output", { timeout: 20000 }, async () => {
  assert.equal(CALCULATION_PROCESS_TIMEOUT_MS, 10000);
  const result = await run(`process.on('SIGTERM', ()=>{}); process.stdout.write('{}'); setInterval(()=>{},1000);`);
  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.equal(result.timedOut, true);
  assert.ok(result.signal);
  assert.throws(() => process.kill(result.pid, 0), "resolution must follow child close");
});
