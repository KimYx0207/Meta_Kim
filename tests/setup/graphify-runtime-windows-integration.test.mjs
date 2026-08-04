import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  detectPython310,
  resolveGraphifyExecutable,
} from "../../scripts/graphify-runtime.mjs";

test("real Windows Graphify discovery stays on hidden absolute python.exe probes", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only Graphify executable integration proof");
    return;
  }
  const calls = [];
  const hiddenSpawn = (command, args, options = {}) => {
    calls.push({ command, args, options });
    assert.equal(options.windowsHide, true);
    return spawnSync(command, args, options);
  };
  const python = detectPython310(hiddenSpawn, "win32", { requirePip: true });
  if (!python) {
    t.skip("an absolute Python 3.10+ interpreter with pip is unavailable");
    return;
  }
  assert.equal(path.win32.isAbsolute(python.command), true);
  assert.match(python.command, /python(?:3)?\.exe$/iu);
  assert.equal(calls.some((call) => call.command.toLowerCase() === "py"), false);

  const executable = resolveGraphifyExecutable(python, hiddenSpawn);
  if (!executable) {
    t.skip("Graphify is not installed for the discovered absolute interpreter");
    return;
  }
  assert.match(
    executable,
    /[\\/]graphify\.exe$/iu,
  );
  assert.equal(path.win32.isAbsolute(executable), true);
});
