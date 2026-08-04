import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  resolveRuntimeLaunchRebindRequest,
  runRuntimeLaunchRebind,
} from "../../scripts/runtime-launch-rebind.mjs";

describe("runtime launch inventory rebind", () => {
  test("normalizes targets and accepts both scope forms", () => {
    assert.deepEqual(
      resolveRuntimeLaunchRebindRequest([
        "--targets", "CODEX", "--targets=claude", "--scope=project",
      ]),
      { targets: ["codex", "claude"], scope: "project" },
    );
    assert.deepEqual(resolveRuntimeLaunchRebindRequest([]), {
      targets: ["claude", "codex"],
      scope: "global",
    });
  });

  test("rejects unknown targets and unsupported scopes before writes", () => {
    assert.throws(
      () => resolveRuntimeLaunchRebindRequest(["--targets", "codex,typo"]),
      /Unknown runtime target: typo/u,
    );
    assert.throws(
      () => resolveRuntimeLaunchRebindRequest(["--targets", "cursor"]),
      /does not support cursor/u,
    );
    assert.throws(
      () => resolveRuntimeLaunchRebindRequest(["--scope=both"]),
      /does not support scope both/u,
    );
  });

  test("engine rejection and successful refresh have exact side-effect boundaries", async () => {
    const refreshes = [];
    const errors = [];
    const outputs = [];
    const common = {
      argv: ["--targets=codex", "--scope=global"],
      minimumNodeVersion: "20.0.0",
      refreshBindings: async (...args) => {
        refreshes.push(args);
        return true;
      },
      writeError: (message) => errors.push(message),
      writeOutput: (message) => outputs.push(message),
    };

    assert.equal(await runRuntimeLaunchRebind({
      ...common,
      nodeVersion: "18.0.0",
      supportsNodeVersion: () => false,
    }), false);
    assert.deepEqual(refreshes, []);

    assert.equal(await runRuntimeLaunchRebind({
      ...common,
      nodeVersion: "22.0.0",
      supportsNodeVersion: () => true,
    }), true);
    assert.deepEqual(refreshes, [[["codex"], "global"]]);
    assert.match(outputs[0], /codex \(scope: global\)/u);
    assert.equal(errors.length, 1);
  });
});
