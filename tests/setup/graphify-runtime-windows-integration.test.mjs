import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveGraphifyExecutable } from "../../scripts/graphify-runtime.mjs";

test("real py -3 resolves the versioned Windows user Graphify script", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only Graphify executable integration proof");
    return;
  }
  const py = spawnSync("py", ["-3", "--version"], {
    encoding: "utf8",
    shell: false,
  });
  if (py.error || py.status !== 0) {
    t.skip("py -3 is unavailable");
    return;
  }
  const executable = resolveGraphifyExecutable(
    { command: "py", args: ["-3"] },
    spawnSync,
  );
  if (!executable) {
    t.skip("Graphify is not installed for py -3");
    return;
  }
  assert.match(
    executable,
    /[\\/]AppData[\\/]Roaming[\\/]Python[\\/]Python\d+[\\/]Scripts[\\/]graphify\.exe$/iu,
  );
});
