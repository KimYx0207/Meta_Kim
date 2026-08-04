import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  resolveNpmCliJsPath,
  resolveWindowsCliInvocation,
  spawnCli,
} from "../../scripts/runtime-cli-invocation.mjs";

async function writeNodeCmdShim(directory, command) {
  const target = path.join(directory, `${command}.js`);
  const shim = path.join(directory, `${command}.cmd`);
  await fs.writeFile(target, "process.exitCode = 0;\n", "utf8");
  await fs.writeFile(shim, `@"%~dp0\\${command}.js" %*\r\n`, "utf8");
  return { shim, target };
}

test("Windows CLI resolution keeps an earlier PATH cmd shim ahead of a later exe", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-cli-path-order-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const earlier = path.join(root, "earlier");
  const later = path.join(root, "later");
  await fs.mkdir(earlier);
  await fs.mkdir(later);
  const { target } = await writeNodeCmdShim(earlier, "codex");
  await fs.writeFile(path.join(later, "codex.exe"), "packaged-app-alias", "utf8");

  const invocation = resolveWindowsCliInvocation("codex", ["--version"], {
    pathValue: `${earlier};${later}`,
  });

  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [target, "--version"]);
  assert.equal(invocation.source, "node_or_native_shim_without_cmd");
});

test("Windows CLI resolution keeps native executable priority within one PATH directory", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-cli-native-first-"));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const native = path.join(directory, "codex.exe");
  await fs.writeFile(native, "native", "utf8");
  await writeNodeCmdShim(directory, "codex");

  const invocation = resolveWindowsCliInvocation("codex", ["--version"], {
    pathValue: directory,
  });

  assert.equal(invocation.command, native);
  assert.deepEqual(invocation.args, ["--version"]);
  assert.equal(invocation.source, "native_executable");
});

test("npm CLI resolution falls back to a PATH shim when the active Node has no bundled npm", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-npm-cli-fallback-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const nodeDirectory = path.join(root, "portable-node-without-npm");
  const npmDirectory = path.join(root, "npm-on-path");
  const npmCli = path.join(npmDirectory, "node_modules", "npm", "bin", "npm-cli.js");
  await fs.mkdir(nodeDirectory, { recursive: true });
  await fs.mkdir(path.dirname(npmCli), { recursive: true });
  await fs.writeFile(path.join(npmDirectory, "npm.cmd"), "@node npm-cli.js %*\r\n", "utf8");
  await fs.writeFile(npmCli, "process.exitCode = 0;\n", "utf8");

  const resolved = resolveNpmCliJsPath({
    env: { PATH: npmDirectory },
    nodeExecutable: path.join(nodeDirectory, "node.exe"),
    platform: "win32",
  });

  assert.equal(resolved, npmCli);
});

test("spawnCli abort waits for child close and prevents late child work", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-cli-abort-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "late-marker.txt");
  const controller = new AbortController();
  const invocation = spawnCli(process.execPath, [
    "-e",
    "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'late'), 300)",
    marker,
  ], {
    cwd: root,
    timeoutMs: 5_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort("test_abort"), 30);
  const result = await invocation;
  assert.equal(result.error?.name, "AbortError");
  assert.notEqual(result.signal, null);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await assert.rejects(fs.access(marker));
});
