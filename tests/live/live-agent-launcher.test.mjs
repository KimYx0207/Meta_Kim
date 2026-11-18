import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main, parseAgentArgs } from "../../scripts/meta-kim-agent.mjs";

test("Agent CLI recognizes one project-bound local app entry, and rejects unknown flags", () => {
  assert.deepEqual(parseAgentArgs(["--project-root", path.resolve("."), "--port", "0", "--no-open"]), {
    open: false, port: 0, json: false, help: false, projectRoot: path.resolve("."),
  });
  for (const args of [["--port", "65536"], ["--project-root", "relative"], ["--command", "bash"], ["--port"]]) {
    assert.throws(() => parseAgentArgs(args));
  }
});

test("Agent launcher opens the existing Live server, not a new project service", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-agent-project-"));
  await mkdir(path.join(projectRoot, ".git"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const controller = await main(["--project-root", projectRoot, "--no-open", "--port", "0", "--json"], {
    ...process.env, META_KIM_CALLER_CWD: projectRoot,
  });
  t.after(() => controller.close());
  const address = controller.address;
  assert.equal(address.host, "127.0.0.1");
  assert.equal((await (await fetch(`${address.url}/api/health`)).json()).agentEntry.enabled, true);
  assert.equal((await (await fetch(`${address.url}/api/health`)).json()).singleton, false);
});

test("Agent refuses unmarked arbitrary directories", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-agent-unmarked-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await assert.rejects(main(["--project-root", projectRoot, "--no-open"]), /not initialized/u);
});

async function startAndReadReceipt(t, liveHome) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-agent-registration-"));
  await mkdir(path.join(projectRoot, ".git"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    if (String(chunk).trimStart().startsWith("{")) { lines.push(String(chunk)); return true; }
    return write.call(process.stdout, chunk, ...rest);
  };
  let controller;
  try {
    controller = await main(["--project-root", projectRoot, "--no-open", "--port", "0", "--json"], {
      ...process.env, META_KIM_CALLER_CWD: projectRoot, META_KIM_LIVE_HOME: liveHome,
    });
  } finally {
    process.stdout.write = write;
  }
  t.after(() => controller.close());
  return JSON.parse(lines.find((line) => line.includes('"listening"')));
}

test("Agent startup receipt reports project registration instead of swallowing failures", async (t) => {
  const liveHome = await mkdtemp(path.join(os.tmpdir(), "meta-kim-agent-home-"));
  t.after(() => rm(liveHome, { recursive: true, force: true }));
  const ok = await startAndReadReceipt(t, liveHome);
  assert.notEqual(ok.projectRegistration.status, "failed");

  // A regular file where the registry home should be makes registration fail.
  const blockedHome = path.join(liveHome, "not-a-directory");
  await writeFile(blockedHome, "x");
  const failed = await startAndReadReceipt(t, blockedHome);
  assert.equal(failed.status, "listening", "registration failure stays non-fatal for this project");
  assert.equal(failed.projectRegistration.status, "failed");
  assert.equal(failed.projectRegistration.known, false);
  assert.match(failed.projectRegistration.errorCode, /^[A-Za-z_]+$/u);
  assert.doesNotMatch(JSON.stringify(failed.projectRegistration), /not-a-directory|[\\/]tmp[\\/]/u, "no host paths in the receipt");
});
