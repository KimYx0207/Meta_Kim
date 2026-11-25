import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { describeGlobalHookDrift } from "../../scripts/global-hook-diagnostics.mjs";

test("global hook drift distinguishes missing, changed, grouped and moved entries without revealing values", () => {
  const owned = (name, args = "", timeout = 5) => ({ command: `node /private/${name}.mjs ${args}`, timeout });
  const a = owned("a", "--api-key=actual-secret");
  const b = owned("b");
  const c = owned("c");
  const actual = {
    PreToolUse: [{ matcher: "private-matcher", hooks: [b, { ...a, timeout: 17 }] }],
    Stop: [b, a],
    UserPromptSubmit: [b],
    PostToolUse: [{ matcher: "private-matcher", hooks: [a, b] }],
  };
  const expected = {
    PreToolUse: [{ matcher: "private-matcher", hooks: [a, b, c] }],
    Stop: [a, b],
    UserPromptSubmit: [owned("b", "--token=expected-secret")],
    PostToolUse: [{ hooks: [a] }, { hooks: [b] }],
  };
  const diagnostics = describeGlobalHookDrift(actual, expected, Object.keys(expected));
  assert.match(diagnostics.join("\n"), /PreToolUse.*missing=1.*changed=1.*order/u);
  assert.match(diagnostics.join("\n"), /Stop.*order/u);
  assert.match(diagnostics.join("\n"), /UserPromptSubmit.*changed=1/u);
  assert.match(diagnostics.join("\n"), /PostToolUse.*grouping/u);
  assert.doesNotMatch(diagnostics.join("\n"), /private|secret|\.mjs/u);
  assert.deepEqual(describeGlobalHookDrift(expected, expected, Object.keys(expected)), []);
});

test("Cursor check reports hook order drift and leaves configuration bytes alone", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "meta-kim-cursor-drift-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cursor = path.join(home, ".cursor");
  const args = ["scripts/sync-global-meta-theory.mjs", "--targets", "cursor", "--with-global-hooks", "--skip-durable-mcp"];
  const run = (...extra) => spawnSync(process.execPath, [...args, ...extra], {
    env: { ...process.env, HOME: home, USERPROFILE: home, META_KIM_CURSOR_HOME: cursor },
    encoding: "utf8",
    timeout: 30000,
  });
  const installed = run();
  assert.equal(installed.status, 0, installed.stderr);
  const file = path.join(cursor, "hooks.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.hooks.preToolUse.reverse();
  config.hooks.preToolUse[0].command += " --probe-secret=test-value";
  const input = JSON.stringify(config);
  writeFileSync(file, input);
  const checked = run("--check");
  assert.equal(checked.status, 1, checked.stderr || checked.stdout);
  assert.match(checked.stdout, /Cursor configured vs expected: preToolUse:.*changed=1.*order differs/u);
  assert.doesNotMatch(`${checked.stdout}\n${checked.stderr}`, /probe-secret|test-value/u);
  assert.equal(readFileSync(file, "utf8"), input);
});
