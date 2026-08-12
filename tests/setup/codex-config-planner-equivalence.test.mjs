import { describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  ensureCodexAppNativeControls,
  invertCodexConfigMutations,
  planCodexAppNativeControls,
} from "../../scripts/codex-config-merge.mjs";

const unavailablePath = () => false;
const discoveredMarketplaceSource = path.join(
  os.tmpdir(),
  "meta-kim-codex-app-fixture",
  "app",
  "resources",
  "plugins",
  "openai-bundled",
);

function activeTomlSurface(configText) {
  return String(configText ?? "")
    .replace(/^\uFEFF/u, "")
    .split(/\r\n|\n|\r/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"));
}

const cases = [
  {
    name: "feature replacements and insertions",
    input: [
      'model = "gpt-5.5"',
      "",
      "[features]",
      "default_mode_request_user_input = false",
      "",
    ].join("\n"),
    options: { platformName: "linux" },
  },
  {
    name: "MCP mixed-transport conflict cleanup",
    input: [
      "[mcp_servers.exa]",
      'url = "https://mcp.example.test/mcp"',
      'command = "npx"',
      'args = ["-y", "mcp-remote", "https://mcp.example.test/mcp"]',
      "startup_timeout_sec = 30",
      "",
    ].join("\n"),
    options: { platformName: "linux" },
  },
  {
    name: "Windows notify replacement and stale marketplace removal",
    input: [
      'approval_policy = "on-request"',
      "notify = [",
      '  "terminal-notifier",',
      '  "-message", "Task completed!",',
      "]",
      "",
      "[features]",
      "default_mode_request_user_input = false",
      "",
      '[plugins."browser@openai-bundled"]',
      "enabled = false",
      "",
      "[marketplaces.openai-bundled]",
      'source_type = "git"',
      "source = 'X:/fixture/.codex/.tmp/bundled-marketplaces/openai-bundled'",
      "",
    ].join("\n"),
    options: {
      platformName: "win32",
      windowsAppsRoots: [],
      pathExists: unavailablePath,
    },
  },
  {
    name: "Windows discovered marketplace source replacement",
    input: [
      "[marketplaces.openai-bundled]",
      'source_type = "git"',
      "source = 'X:/fixture/old-openai-bundled'",
      "",
    ].join("\n"),
    options: {
      platformName: "win32",
      windowsAppsRoots: [],
      bundledMarketplaceSource: discoveredMarketplaceSource,
      pathExists: (candidate) => candidate === discoveredMarketplaceSource,
    },
  },
];

describe("Codex config native-control planner compatibility", () => {
  for (const scenario of cases) {
    test(`${scenario.name}: matches the production merge and journals every byte delta`, () => {
      const expected = ensureCodexAppNativeControls(
        scenario.input,
        scenario.options,
      );
      const planned = planCodexAppNativeControls(
        scenario.input,
        scenario.options,
      );

      assert.deepEqual(
        activeTomlSurface(planned.text),
        activeTomlSurface(expected),
        "planner.text must expose the same active TOML as the existing production merge",
      );
      assert.ok(
        planned.mutations.length > 0,
        "a changed document must emit a non-empty mutation journal",
      );

      // The manifest persists this payload as JSON. Exact inversion from the
      // serialized journal proves that no planner text delta escaped ownership.
      const persistedJournal = JSON.parse(JSON.stringify(planned.mutations));
      assert.equal(
        invertCodexConfigMutations(planned.text, persistedJournal),
        scenario.input,
        "the serialized journal must cover the complete planner delta",
      );
    });
  }

  test("an already compliant document remains a byte-identical no-op", () => {
    const input = [
      "[features]",
      "default_mode_request_user_input = true # user comment",
      "js_repl = true",
      "",
      "[agents]",
      "max_threads = 2",
      "max_depth = 1",
      "",
    ].join("\n");
    const options = { platformName: "linux" };
    const planned = planCodexAppNativeControls(input, options);

    assert.equal(planned.text, input);
    assert.deepEqual(planned.mutations, []);
  });
});
