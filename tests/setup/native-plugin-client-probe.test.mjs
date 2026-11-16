import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeZCodePluginInventory,
  inspectExpectedPlugin,
  probePluginClient,
} from "../../scripts/probe-native-plugin-client.mjs";

test("ZCode native plugin inventory accepts observed records without claiming an active session", () => {
  const rows = normalizeZCodePluginInventory(JSON.stringify({
    plugins: [{ id: "meta-kim@personal", version: "3.16.3", enabled: true }],
  }));
  assert.equal(inspectExpectedPlugin(rows, "meta-kim@personal").inventoryPass, true);
  const actual = probePluginClient("zcode", "meta-kim@personal", (command, args) => {
    assert.equal(command, "zcode");
    if (args[0] === "version") return { status: 0, stdout: "zcode 0.18.0" };
    assert.deepEqual(args, ["plugins", "list", "--json"]);
    return { status: 0, stdout: JSON.stringify(rows) };
  });
  assert.equal(actual.inventoryPass, true);
  assert.equal(actual.sessionReloadVerified, false);
  assert.equal(actual.liveInvocationVerified, false);
  assert.match(actual.reason, /actual client/i);
});

test("ZCode missing release CLI is an explicit gap, never an automatic pass", () => {
  const actual = probePluginClient("zcode", "meta-kim", (_, args) =>
    args[0] === "version" ? { status: 0, stdout: "zcode 0.16.3" } : { status: 1, stderr: "unknown command" });
  assert.equal(actual.inventoryObserved, false);
  assert.equal(actual.inventoryPass, false);
  assert.equal(actual.sessionReloadVerified, false);
  assert.match(actual.reason, /Plugins settings/);
});

test("Claude native CLI plugin errors and disabled state fail inventory acceptance", () => {
  const cli = (command, args) => {
    assert.equal(command, "claude");
    return args[0] === "--version"
      ? { status: 0, stdout: "claude 2.1.300" }
      : { status: 0, stdout: JSON.stringify([{ id: "ecc@ecc", enabled: false, scope: "user", version: "2.0.0", errors: ["load failure"] }]) };
  };
  const actual = probePluginClient("claude", "ecc@ecc", cli);
  assert.equal(actual.inventoryObserved, true);
  assert.equal(actual.plugin.present, true);
  assert.equal(actual.plugin.enabled, false);
  assert.equal(actual.plugin.loadErrors, 1);
  assert.equal(actual.inventoryPass, false);
  assert.equal(actual.sessionReloadVerified, false);
  assert.throws(() => normalizeZCodePluginInventory('{}'), /unknown schema/);
});
