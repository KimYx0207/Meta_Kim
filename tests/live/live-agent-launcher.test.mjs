import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
