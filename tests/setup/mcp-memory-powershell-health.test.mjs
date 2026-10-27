import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

import { renderCurrentWindowsMcpMemoryPowerShellBytes } from "../../scripts/mcp-memory-boot-artifacts.mjs";
import { resolveTrustedWindowsSystemTool } from "../../scripts/mcp-memory-process-control.mjs";

function healthFunction(healthUrl) {
  const endpoint = new URL(healthUrl);
  const source = renderCurrentWindowsMcpMemoryPowerShellBytes({
    memoryBin: String.raw`C:\MetaKimFixture\Scripts\memory.exe`,
    databasePath: String.raw`C:\MetaKimFixture\sqlite_vec.db`,
    endpointUrl: endpoint.origin,
    healthUrl,
    hostname: endpoint.hostname,
    port: endpoint.port,
    failureMessage: `Fixture ${healthUrl}: MCP_ALLOW_ANONYMOUS_ACCESS=true memory server --http`,
    lockDir: String.raw`C:\MetaKimFixture\.meta-kim\locks\memory.lock`,
  }).toString("utf8");
  const match = /^function Test-MetaKimMemoryHealth \{\r\n[\s\S]*?^\}\r\n/mu.exec(source);
  assert.ok(match, "extract only the generated health function, not the service launcher");
  assert.doesNotMatch(match[0], /Start-Process|Remove-MetaKimOwnedLock/u);
  return match[0];
}

/** Execute only the generated probe in a fresh, hidden Windows PowerShell 5.1. */
async function runHealthProbe(powershell, healthUrl) {
  const command = [
    "if ($PSVersionTable.PSVersion.Major -ne 5) { exit 3 }",
    healthFunction(healthUrl),
    "Write-Output ('probe-result=' + [bool](Test-MetaKimMemoryHealth))",
  ].join("\r\n");
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(0, 65_536); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(0, 65_536); });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}/api/health`;
}

async function close(server) {
  if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("generated health probe works in a fresh Windows PowerShell 5.1 without a profile", {
  skip: process.platform !== "win32",
  timeout: 75_000,
}, async (context) => {
  const powershell = resolveTrustedWindowsSystemTool(["WindowsPowerShell", "v1.0", "powershell.exe"]);
  assert.ok(powershell, "Windows PowerShell must resolve from the trusted system directory");
  let statusCode = 200;
  let body = JSON.stringify({ status: "healthy" });
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(statusCode, { "Content-Type": "application/json" });
    response.end(body);
  });
  const healthUrl = await listen(server);
  context.after(() => close(server));

  for (const scenario of [
    { name: "healthy", statusCode: 200, body: { status: "healthy" }, expected: true },
    { name: "unhealthy", statusCode: 200, body: { status: "starting" }, expected: false },
    { name: "HTTP failure with a healthy-looking payload", statusCode: 503, body: { status: "healthy" }, expected: false },
    { name: "invalid JSON", statusCode: 200, body: "not json", expected: false },
  ]) {
    await context.test(scenario.name, async () => {
      statusCode = scenario.statusCode;
      body = typeof scenario.body === "string" ? scenario.body : JSON.stringify(scenario.body);
      const before = requests.length;
      const result = await runHealthProbe(powershell, healthUrl);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout.trim(), `probe-result=${scenario.expected ? "True" : "False"}`);
      assert.equal(requests.length, before + 1, "the generated function reached the temporary HTTP fixture");
      assert.equal(requests.at(-1), "/api/health");
    });
  }

  await context.test("connection failure", async () => {
    await close(server);
    const result = await runHealthProbe(powershell, healthUrl);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim(), "probe-result=False");
  });
});
