import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CODEX_DEFAULT_AGENT_MAX_THREADS,
  CODEX_LEGACY_META_KIM_AGENT_MAX_THREADS,
  assertCodexConfigTomlMergeable,
  ensureCodexAppNativeControls,
  ensureCodexWindowsNotifyCompat,
  ensureCodexRequestUserInputFeature,
  hasCodexRequestUserInputFeature,
  invertCodexConfigMutations,
  mergeCodexConfigAddOnly,
  normalizeCodexConfigMutations,
  planCodexAppNativeControls,
  reconcileCodexConfigAfterUpstreamInstall,
  removeMetaKimTemporaryProjectResidue,
} from "../../scripts/codex-config-merge.mjs";

function sectionBlock(configText, sectionName) {
  const lines = String(configText).replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === `[${sectionName}]`);
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("Codex config merge", () => {
  test("resource-safe agent defaults migrate the legacy Meta_Kim value and preserve explicit overrides", () => {
    const legacy = ensureCodexAppNativeControls(
      `[agents]\nmax_threads = ${CODEX_LEGACY_META_KIM_AGENT_MAX_THREADS}\n`,
      { platformName: "linux" },
    );
    assert.match(legacy, new RegExp(`max_threads = ${CODEX_DEFAULT_AGENT_MAX_THREADS}`));
    assert.match(legacy, /max_depth = 1/);

    const explicit = ensureCodexAppNativeControls(
      "[agents]\nmax_threads = 3\nmax_depth = 2\n",
      { platformName: "linux" },
    );
    assert.match(explicit, /max_threads = 3/);
    assert.match(explicit, /max_depth = 2/);
  });

  test("upstream dependency output cannot resurrect deleted MCPs or temporary projects", () => {
    const snapshot = [
      'model = "gpt-5.6"',
      "",
      "[mcp_servers.user_owned]",
      'command = "node"',
      "",
      '[projects.\'D:/User/RealProject\']',
      'trust_level = "trusted"',
      "",
      '[projects.\'C:/Users/Kim/AppData/Local/Temp/meta-kim-context-ab-deadbeef/codex-workspace/trial\']',
      'trust_level = "trusted"',
      "",
    ].join("\n");
    const upstream = [
      "[mcp_servers.github]",
      'command = "npx"',
      "",
      "[mcp_servers.memory]",
      'command = "npx"',
      "",
      "[mcp_servers.sequential-thinking]",
      'command = "npx"',
      "",
      '[projects.\'C:/Temp/meta-kim-harness-fitness-lab-workspaces/run/trial\']',
      'trust_level = "trusted"',
      "",
    ].join("\n");

    const out = reconcileCodexConfigAfterUpstreamInstall(snapshot, upstream, {
      platformName: "linux",
    });

    assert.match(out, /mcp_servers\.user_owned/);
    assert.match(out, /D:\/User\/RealProject/);
    assert.doesNotMatch(out, /mcp_servers\.(?:github|memory|sequential-thinking)/);
    assert.doesNotMatch(out, /meta-kim-(?:context-ab|harness-fitness)/i);
    assert.match(out, /max_threads = 2/);
  });

  test("an absent pre-install config never adopts an upstream-owned Codex config", () => {
    const upstream = [
      'approval_policy = "never"',
      "[mcp_servers.github]",
      'command = "npx"',
      '[projects.\'C:/Temp/meta-kim-context-ab-deadbeef/workspace\']',
      'trust_level = "trusted"',
    ].join("\n");
    const out = reconcileCodexConfigAfterUpstreamInstall(null, upstream, {
      platformName: "linux",
    });
    assert.doesNotMatch(out, /approval_policy|mcp_servers|projects/);
    assert.match(out, /\[agents\][\s\S]*max_threads = 2[\s\S]*max_depth = 1/);
  });

  test("temporary project residue cleanup is exact and preserves user projects", () => {
    const input = [
      '[projects.\'C:/Temp/meta-kim-harness-fitness-lab-workspaces/run/trial\']',
      'trust_level = "trusted"',
      "",
      '[projects.\'D:/KimProject/Meta_Kim/.meta-kim/state/default/harness-fitness-lab/workspaces/run/trial\']',
      'trust_level = "trusted"',
      "",
      '[projects.\'C:/Users/Kim/AppData/Local/Temp/meta-kim-p116-formal-workspaces/run/trial\']',
      'trust_level = "trusted"',
      "",
      '[projects.\'D:/User/meta-kim-context-ab-not-a-temp-project\']',
      'trust_level = "trusted"',
      "",
    ].join("\n");
    const out = removeMetaKimTemporaryProjectResidue(input);
    assert.doesNotMatch(out, /harness-fitness-lab-workspaces/);
    assert.doesNotMatch(out, /\.meta-kim\/state\/default\/harness-fitness-lab/);
    assert.doesNotMatch(out, /meta-kim-p116-formal-workspaces/);
    assert.match(out, /D:\/User\/meta-kim-context-ab-not-a-temp-project/);
  });

  test("native-control planner leaves already-equal bytes untouched", () => {
    const input = "\uFEFF[features]\r\ndefault_mode_request_user_input = true # keep\r\njs_repl = true\r\n\r\n[agents]\r\nmax_threads = 2\r\nmax_depth = 1\r\n";
    const planned = planCodexAppNativeControls(input, { platformName: "linux" });
    assert.equal(planned.text, input);
    assert.deepEqual(planned.mutations, []);
  });

  test("native-control mutations are actual deltas and invert exactly", () => {
    const input = [
      'model = "gpt-5.5"',
      "",
      "[features]",
      "default_mode_request_user_input = false # preserve comment",
      "js_repl = true",
      "",
    ].join("\r\n");
    const planned = planCodexAppNativeControls(input, { platformName: "linux" });
    assert.equal(planned.mutations.length, 3);
    assert.deepEqual(planned.mutations[0], {
      kind: "replace",
      locator: { table: "features", key: "default_mode_request_user_input" },
      beforeFragment: "default_mode_request_user_input = false # preserve comment",
      afterFragment: "default_mode_request_user_input = true # preserve comment",
    });
    assert.deepEqual(
      planned.mutations.slice(1).map((mutation) => mutation.locator),
      [
        { table: "agents", key: "max_threads" },
        { table: "agents", key: "max_depth" },
      ],
    );
    assert.match(planned.text, /true # preserve comment\r\n/u);
    assert.equal(invertCodexConfigMutations(planned.text, planned.mutations), input);
  });

  test("inverse preserves unrelated edits and rejects managed drift", () => {
    const input = [
      'model = "gpt-5.5"',
      "[features]",
      "default_mode_request_user_input = false",
      "js_repl = true",
      "",
    ].join("\n");
    const planned = planCodexAppNativeControls(input, { platformName: "linux" });
    const userEdited = planned.text.replace('model = "gpt-5.5"', 'model = "gpt-5.6"');
    const inverted = invertCodexConfigMutations(userEdited, planned.mutations);
    assert.match(inverted, /model = "gpt-5\.6"/u);
    assert.match(inverted, /default_mode_request_user_input = false/u);

    const drifted = planned.text.replace(
      "default_mode_request_user_input = true",
      "default_mode_request_user_input = false # user took ownership",
    );
    assert.throws(
      () => invertCodexConfigMutations(drifted, planned.mutations),
      /managed fragment drifted/u,
    );
  });

  test("inverse keeps a newly added table header when user content makes removal ambiguous", () => {
    const input = 'model = "gpt-5.5"\n';
    const planned = planCodexAppNativeControls(input, { platformName: "linux" });
    const withUserSetting = planned.text.replace(
      "js_repl = true",
      "js_repl = true\nuser_feature = true",
    );
    const inverted = invertCodexConfigMutations(withUserSetting, planned.mutations);
    assert.match(inverted, /\[features\]/u);
    assert.match(inverted, /user_feature = true/u);
    assert.doesNotMatch(inverted, /default_mode_request_user_input|js_repl/u);
  });

  test("mutation normalization compresses a contiguous locator chain", () => {
    const inserted = {
      kind: "insert",
      locator: { table: "features", key: "js_repl" },
      beforeFragment: "",
      afterFragment: "js_repl = true\n",
    };
    const replaced = {
      kind: "replace",
      locator: { table: "features", key: "js_repl" },
      beforeFragment: "js_repl = true",
      afterFragment: "js_repl = false",
    };
    assert.deepEqual(normalizeCodexConfigMutations([inserted, replaced]), [{
      ...inserted,
      afterFragment: "js_repl = false\n",
    }]);
  });

  test("mutation normalization treats an exact host-restored replay as one ownership layer", () => {
    const replayed = {
      kind: "replace",
      locator: { table: "features", key: "js_repl" },
      beforeFragment: "js_repl = false",
      afterFragment: "js_repl = true",
    };
    assert.deepEqual(
      normalizeCodexConfigMutations([replayed, structuredClone(replayed)]),
      [replayed],
    );
    assert.throws(
      () => normalizeCodexConfigMutations([
        replayed,
        { ...replayed, afterFragment: "js_repl = false # changed" },
      ]),
      /Non-contiguous Codex config mutation chain/u,
    );
  });

  test("mutation normalization rebases a regenerated host value only when the managed result is unchanged", () => {
    const previous = {
      kind: "replace",
      locator: { table: "marketplaces.openai-bundled", key: "source" },
      beforeFragment: "source = 'host-a'",
      afterFragment: "# disabled source",
    };
    const rebased = {
      ...previous,
      beforeFragment: "source = 'host-b'",
    };
    assert.deepEqual(
      normalizeCodexConfigMutations([previous, rebased]),
      [rebased],
    );
    assert.throws(
      () => normalizeCodexConfigMutations([
        previous,
        { ...rebased, afterFragment: "# different managed result" },
      ]),
      /Non-contiguous Codex config mutation chain/u,
    );
  });

  test("Windows planner journals notify marketplace and MCP semantic changes", () => {
    const source = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_test\\app\\resources\\plugins\\openai-bundled";
    const input = [
      "notify = [",
      '  "terminal-notifier",',
      '  "done"',
      "]",
      "",
      "[features]",
      "default_mode_request_user_input = false",
      "js_repl = true",
      "",
      "[marketplaces.openai-bundled]",
      'source_type = "local"',
      "source = 'C:\\Users\\Kim\\.codex\\.tmp\\bundled-marketplaces\\openai-bundled'",
      "",
      "[mcp_servers.exa]",
      'url = "https://mcp.example"',
      'command = "npx"',
      "",
    ].join("\r\n");
    const planned = planCodexAppNativeControls(input, {
      platformName: "win32",
      bundledMarketplaceSource: source,
      pathExists: (candidate) => candidate.replace(/^\\\\\?\\/u, "") === source,
    });
    const identities = planned.mutations.map(({ locator }) => `${locator.table}.${locator.key}`);
    assert.ok(identities.includes(".notify"));
    assert.ok(identities.includes("marketplaces.openai-bundled.source"));
    assert.ok(identities.includes("mcp_servers.exa.url"));
    assert.doesNotMatch(planned.text, /^\s*url\s*=/mu);
    assert.doesNotMatch(planned.text, /terminal-notifier/u);
    assert.ok(planned.text.includes(`source = '\\\\?\\${source}'`));
    assert.equal(invertCodexConfigMutations(planned.text, planned.mutations), input);
  });

  test("inverse fails closed when a managed table becomes duplicated", () => {
    const input = "[features]\ndefault_mode_request_user_input = false\njs_repl = true\n";
    const planned = planCodexAppNativeControls(input, { platformName: "linux" });
    const duplicated = `${planned.text}\n[features]\nuser = true\n`;
    assert.throws(
      () => invertCodexConfigMutations(duplicated, planned.mutations),
      /managed table is missing or ambiguous/u,
    );
  });

  test("inverse fails closed when a managed table key becomes duplicated", () => {
    const input = "[features]\ndefault_mode_request_user_input = false\njs_repl = true\n";
    const planned = planCodexAppNativeControls(input, { platformName: "linux" });
    const duplicated = planned.text.replace(
      "js_repl = true",
      "js_repl = true\ndefault_mode_request_user_input = true",
    );
    assert.throws(
      () => invertCodexConfigMutations(duplicated, planned.mutations),
      /managed locator is ambiguous/u,
    );
  });

  test("inverse fails closed when root notify becomes duplicated", () => {
    const input = [
      "notify = [",
      '  "terminal-notifier",',
      '  "done"',
      "]",
      "",
      "[features]",
      "default_mode_request_user_input = true",
      "js_repl = true",
      "",
    ].join("\n");
    const planned = planCodexAppNativeControls(input, { platformName: "win32" });
    const duplicated = planned.text.replace(
      "\n\n[features]",
      '\nnotify = ["powershell.exe"]\n\n[features]',
    );
    assert.throws(
      () => invertCodexConfigMutations(duplicated, planned.mutations),
      /managed locator is ambiguous: \.notify/u,
    );
  });

  test("inverse refuses a recreated active key for a disabled conflict", () => {
    const input = [
      "[features]",
      "default_mode_request_user_input = true",
      "js_repl = true",
      "",
      "[mcp_servers.exa]",
      'url = "https://mcp.example"',
      'command = "npx"',
      "",
    ].join("\n");
    const planned = planCodexAppNativeControls(input, { platformName: "linux" });
    const recreated = planned.text.replace(
      '# Meta_Kim disabled conflicting [mcp_servers.exa].url: url = "https://mcp.example"',
      '# Meta_Kim disabled conflicting [mcp_servers.exa].url: url = "https://mcp.example"\nurl = "https://user.example"',
    );
    assert.throws(
      () => invertCodexConfigMutations(recreated, planned.mutations),
      /disabled locator was recreated or duplicated/u,
    );
  });

  test("planner collapses an adjacent stale disabled comment when its active key reappears", () => {
    const source = String.raw`\\?\C:\Users\Kim\.codex\.tmp\bundled-marketplaces\openai-bundled`;
    const disabled = `# Meta_Kim disabled conflicting [marketplaces.openai-bundled].source: source = '${source}'`;
    const input = [
      "[features]",
      "default_mode_request_user_input = true",
      "js_repl = true",
      "",
      "[marketplaces.openai-bundled]",
      'source_type = "local"',
      `source = '${source}'`,
      disabled,
      "",
    ].join("\n");
    const planned = planCodexAppNativeControls(input, {
      platformName: "win32",
      windowsAppsRoots: [],
      codexHome: String.raw`C:\Users\Kim\.codex`,
      pathExists: () => false,
    });

    assert.equal(planned.text.split(disabled).length - 1, 1);
    assert.doesNotMatch(planned.text, new RegExp(`^source =`, "mu"));
    assert.equal(invertCodexConfigMutations(planned.text, planned.mutations), input);
  });

  test("planner closes prior ownership when Codex regenerates a new valid bundled source", () => {
    const staleSource = String.raw`\\?\C:\Users\Kim\.codex\.tmp\bundled-marketplaces\openai-bundled`;
    const currentSource = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_current\app\resources\plugins\openai-bundled`;
    const original = [
      "[marketplaces.openai-bundled]",
      'source_type = "local"',
      `source = '${staleSource}'`,
      "",
    ].join("\n");
    const first = planCodexAppNativeControls(original, {
      platformName: "win32",
      windowsAppsRoots: [],
      pathExists: () => false,
    });
    const disabled = first.mutations.find(({ locator }) =>
      locator.table === "marketplaces.openai-bundled" && locator.key === "source"
    )?.afterFragment;
    assert.ok(disabled);

    const hostRegenerated = first.text.replace(
      disabled,
      `source = '\\\\?\\${currentSource}'\n${disabled}`,
    );
    const second = planCodexAppNativeControls(hostRegenerated, {
      platformName: "win32",
      bundledMarketplaceSource: currentSource,
      pathExists: (candidate) => candidate.replace(/^\\\\\?\\/u, "") === currentSource,
    });

    assert.ok(second.text.includes(`source = '\\\\?\\${currentSource}'`));
    assert.doesNotMatch(second.text, /Meta_Kim disabled conflicting \[marketplaces\.openai-bundled\]\.source/u);
    assert.deepEqual(
      normalizeCodexConfigMutations([...first.mutations, ...second.mutations]),
      first.mutations.filter(({ locator }) =>
        !(locator.table === "marketplaces.openai-bundled" && locator.key === "source")
      ),
    );
  });

  test("planner fails closed on a managed multiline scalar it cannot replace", () => {
    const input = "[features]\njs_repl = [\n  false\n]\n";
    assert.throws(
      () => planCodexAppNativeControls(input, { platformName: "linux" }),
      /cannot safely locate multiline/u,
    );
  });

  test("adds features section when missing", () => {
    const out = ensureCodexRequestUserInputFeature('model = "gpt-5.5"\n');
    assert.match(out, /\[features\]\ndefault_mode_request_user_input = true/);
    assert.equal(hasCodexRequestUserInputFeature(out), true);
  });

  test("enables existing false value without changing unrelated settings", () => {
    const input = [
      'model = "gpt-5.5"',
      "",
      "[features]",
      "multi_agent = true",
      "default_mode_request_user_input = false",
      "",
      "[agents]",
      "max_threads = 6",
      "",
    ].join("\n");

    const out = ensureCodexRequestUserInputFeature(input);
    assert.match(out, /multi_agent = true/);
    assert.match(out, /default_mode_request_user_input = true/);
    assert.match(out, /\[agents\]\nmax_threads = 6/);
    assert.equal(hasCodexRequestUserInputFeature(out), true);
  });

  test("inserts into existing features section before the next table", () => {
    const input = [
      "[features]",
      "multi_agent = true",
      "[mcp_servers.github]",
      'command = "npx"',
      "",
    ].join("\n");

    const out = ensureCodexRequestUserInputFeature(input);
    assert.match(
      out,
      /\[features\]\nmulti_agent = true\ndefault_mode_request_user_input = true\n\[mcp_servers\.github\]/,
    );
  });

  test("rejects unclosed TOML arrays before Codex feature merges", () => {
    const invalid = [
      "notify = [",
      '  "terminal-notifier"',
      "multi_agent = true",
      "",
    ].join("\n");

    assert.throws(
      () => ensureCodexRequestUserInputFeature(invalid),
      (error) => {
        assert.equal(error.name, "CodexConfigTomlError");
        assert.match(error.message, /line 3:1/);
        assert.match(error.message, /array opened at line 1:10/);
        assert.match(error.message, /multi_agent = true/);
        assert.match(error.message, /\[features\]/);
        assert.match(error.message, /missing comma or closing bracket/);
        return true;
      },
    );
    assert.throws(
      () => mergeCodexConfigAddOnly(invalid, "[features]\njs_repl = true\n"),
      /Codex config\.toml is not safe to merge/,
    );
    assert.throws(
      () => ensureCodexAppNativeControls(invalid, { platformName: "darwin" }),
      /Codex config\.toml is not safe to merge/,
    );
  });

  test("allows valid multiline TOML arrays before feature merges", () => {
    const valid = [
      "notify = [",
      '  "terminal-notifier",',
      '  "-message",',
      '  "done"',
      "]",
      "",
      "[features]",
      "multi_agent = true",
      "",
    ].join("\n");

    assert.doesNotThrow(() => assertCodexConfigTomlMergeable(valid));
    const out = ensureCodexRequestUserInputFeature(valid);
    assert.match(out, /notify = \[/);
    assert.match(out, /\[features\]\nmulti_agent = true\ndefault_mode_request_user_input = true/);
  });

  test("replaces macOS terminal-notifier with Windows-safe no-op notify", () => {
    const input = [
      'approval_policy = "on-request"',
      "notify = [",
      '  "terminal-notifier",',
      '  "-title", "Codex ECC",',
      '  "-message", "Task completed!",',
      "]",
      "",
      "[features]",
      "multi_agent = true",
      "",
    ].join("\n");

    const out = ensureCodexWindowsNotifyCompat(input, "win32");
    assert.doesNotMatch(out, /terminal-notifier/);
    assert.match(out, /notify = \[/);
    assert.match(out, /"powershell\.exe"/);
    assert.match(out, /\$input \| Out-Null/);
    assert.match(out, /\[features\]\nmulti_agent = true/);
  });

  test("leaves terminal-notifier unchanged on non-Windows platforms", () => {
    const input = 'notify = ["terminal-notifier", "-message", "done"]\n';
    const out = ensureCodexWindowsNotifyCompat(input, "darwin");
    assert.equal(out, input);
  });

  test("prefers Codex computer-use helper notify on Windows when present", () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "meta-kim-codex-home-"));
    const helperPath = path.join(
      codexHome,
      "plugins",
      "cache",
      "openai-bundled",
      "computer-use",
      "26.602.71036",
      "node_modules",
      "@oai",
      "sky",
      "bin",
      "windows",
      "codex-computer-use.exe",
    );
    mkdirSync(path.dirname(helperPath), { recursive: true });
    const input = 'notify = ["terminal-notifier", "-message", "done"]\n';

    const out = ensureCodexWindowsNotifyCompat(input, "win32", {
      codexHome,
      pathExists: (candidate) => candidate === helperPath,
    });

    assert.doesNotMatch(out, /terminal-notifier/);
    assert.match(out, /codex-computer-use\.exe/);
    assert.match(out, /"turn-ended"/);
    assert.doesNotMatch(out, /\$input \| Out-Null/);
  });

  test("restores Windows Codex App native controls after ECC config overwrite", () => {
    const bundledSource = path.join(
      mkdtempSync(path.join(os.tmpdir(), "meta-kim-codex-app-")),
      "app",
      "resources",
      "plugins",
      "openai-bundled",
    );
    mkdirSync(bundledSource, { recursive: true });
    const input = [
      'model = "gpt-5.5"',
      "notify = [",
      '  "terminal-notifier",',
      '  "-message", "Task completed!",',
      "]",
      "",
      "[features]",
      "multi_agent = true",
      "default_mode_request_user_input = false",
      "",
      "[mcp_servers.github]",
      'command = "npx"',
      "",
      "[hooks]",
      'stop = "scripts/stop.mjs"',
      "",
      "[agents.frontend]",
      'model = "gpt-5.4"',
      "",
      '[projects."D:/workspace/Meta_Kim"]',
      'trust_level = "trusted"',
      "",
      "[windows]",
      'sandbox = "elevated"',
      "",
      '[plugins."browser@openai-bundled"]',
      "enabled = false",
      "",
      "[marketplaces.openai-bundled]",
      'source_type = "local"',
      "source = '\\\\?\\C:\\Users\\Kim\\.codex\\.tmp\\bundled-marketplaces\\openai-bundled'",
      "",
    ].join("\n");

    const out = ensureCodexAppNativeControls(input, {
      platformName: "win32",
      bundledMarketplaceSource: bundledSource,
      pathExists: (candidate) =>
        candidate.replace(/^\\\\\?\\/, "") === bundledSource,
    });

    assert.doesNotMatch(out, /terminal-notifier/);
    assert.match(out, /"powershell\.exe"/);
    assert.match(out, /default_mode_request_user_input = true/);
    assert.match(out, /js_repl = true/);
    assert.match(out, /\[windows\]\nsandbox = "unelevated"/);
    assert.match(out, /\[plugins\."browser@openai-bundled"\]\nenabled = true/);
    assert.match(out, /\[plugins\."chrome@openai-bundled"\]\nenabled = true/);
    assert.match(out, /\[plugins\."computer-use@openai-bundled"\]\nenabled = true/);
    assert.match(out, /\[marketplaces\.openai-bundled\][\s\S]*source_type = "local"/);
    const expectedSource = /^[A-Za-z]:\\/.test(bundledSource)
      ? `\\\\?\\${bundledSource}`
      : bundledSource;
    assert.ok(out.includes(`source = '${expectedSource}'`));
    assert.doesNotMatch(out, /\\.codex\\.tmp\\bundled-marketplaces\\openai-bundled/i);
    assert.match(out, /\[mcp_servers\.github\]\ncommand = "npx"/);
    assert.match(out, /\[hooks\]\nstop = "scripts\/stop\.mjs"/);
    assert.match(out, /\[agents\.frontend\]\nmodel = "gpt-5.4"/);
    assert.match(out, /\[projects\."D:\/workspace\/Meta_Kim"\]\ntrust_level = "trusted"/);
  });

  test("does not add Windows-only App plugin blocks on non-Windows platforms", () => {
    const input = [
      "[features]",
      "multi_agent = true",
      "",
    ].join("\n");

    const out = ensureCodexAppNativeControls(input, { platformName: "linux" });

    assert.match(out, /js_repl = true/);
    assert.doesNotMatch(out, /\[windows\]/);
    assert.doesNotMatch(out, /openai-bundled/);
  });

  test("merges ECC overwrite output add-only into the original user config", () => {
    const originalUserConfig = [
      'approval_policy = "never"',
      'sandbox_mode = "workspace-write"',
      "",
      "[features]",
      "multi_agent = false",
      "",
      "[mcp_servers.private]",
      'command = "node"',
      'args = ["private-server.mjs"]',
      "",
      "[hooks]",
      'stop = "scripts/user-stop.mjs"',
      "",
      "[agents.custom]",
      'description = "User custom agent"',
      "",
      '[projects."D:/User/Project"]',
      'trust_level = "trusted"',
      "",
    ].join("\n");
    const eccOverwriteConfig = [
      'approval_policy = "on-request"',
      'sandbox_mode = "read-only"',
      'web_search = "live"',
      "",
      "[features]",
      "multi_agent = true",
      "",
      "[mcp_servers.context7]",
      'command = "npx"',
      'args = ["-y", "@upstash/context7-mcp@latest"]',
      "",
      "[agents.explorer]",
      'description = "ECC explorer"',
      "",
    ].join("\n");

    const out = mergeCodexConfigAddOnly(originalUserConfig, eccOverwriteConfig);

    assert.match(out, /approval_policy = "never"/);
    assert.match(out, /sandbox_mode = "workspace-write"/);
    assert.match(out, /web_search = "live"/);
    assert.match(out, /\[features\]\nmulti_agent = false/);
    assert.match(out, /\[mcp_servers\.private\]\ncommand = "node"\nargs = \["private-server\.mjs"\]/);
    assert.match(out, /\[mcp_servers\.context7\]\ncommand = "npx"\nargs = \["-y", "@upstash\/context7-mcp@latest"\]/);
    assert.match(out, /\[hooks\]\nstop = "scripts\/user-stop\.mjs"/);
    assert.match(out, /\[agents\.custom\]\ndescription = "User custom agent"/);
    assert.match(out, /\[agents\.explorer\]\ndescription = "ECC explorer"/);
    assert.match(out, /\[projects\."D:\/User\/Project"\]\ntrust_level = "trusted"/);
    assert.doesNotMatch(out, /approval_policy = "on-request"/);
    assert.doesNotMatch(out, /sandbox_mode = "read-only"/);
  });

  test("normalizes MCP server when upstream replaces remote url with stdio command", () => {
    const originalUserConfig = [
      "[mcp_servers.exa]",
      'url = "https://mcp.exa.ai/mcp"',
      "enabled = false",
      "",
    ].join("\n");
    const upstreamConfig = [
      "[mcp_servers.exa]",
      'command = "npx"',
      'args = ["-y", "mcp-remote", "https://mcp.exa.ai/mcp"]',
      "startup_timeout_sec = 30",
      "",
    ].join("\n");

    const out = mergeCodexConfigAddOnly(originalUserConfig, upstreamConfig);
    const exa = sectionBlock(out, "mcp_servers.exa");

    assert.match(exa, /command = "npx"/);
    assert.match(
      exa,
      /args = \["-y", "mcp-remote", "https:\/\/mcp\.exa\.ai\/mcp"\]/,
    );
    assert.match(exa, /startup_timeout_sec = 30/);
    assert.match(exa, /enabled = false/);
    assert.doesNotMatch(exa, /^\s*url\s*=/m);
  });

  test("normalizes MCP server when upstream replaces stdio command with remote url", () => {
    const originalUserConfig = [
      "[mcp_servers.exa]",
      'command = "npx"',
      'args = ["-y", "mcp-remote", "https://mcp.exa.ai/mcp"]',
      "startup_timeout_sec = 30",
      "",
    ].join("\n");
    const upstreamConfig = [
      "[mcp_servers.exa]",
      'url = "https://mcp.exa.ai/mcp"',
      "startup_timeout_sec = 30",
      "",
    ].join("\n");

    const out = mergeCodexConfigAddOnly(originalUserConfig, upstreamConfig);
    const exa = sectionBlock(out, "mcp_servers.exa");

    assert.match(exa, /url = "https:\/\/mcp\.exa\.ai\/mcp"/);
    assert.match(exa, /startup_timeout_sec = 30/);
    assert.doesNotMatch(exa, /^\s*command\s*=/m);
    assert.doesNotMatch(exa, /^\s*args\s*=/m);
  });

  test("cleans an existing invalid MCP url plus stdio server during app control sync", () => {
    const input = [
      "[mcp_servers.exa]",
      'url = "https://mcp.exa.ai/mcp"',
      'command = "npx"',
      'args = ["-y", "mcp-remote", "https://mcp.exa.ai/mcp"]',
      "startup_timeout_sec = 30",
      "",
    ].join("\n");

    const out = ensureCodexAppNativeControls(input, { platformName: "linux" });
    const exa = sectionBlock(out, "mcp_servers.exa");

    assert.match(exa, /command = "npx"/);
    assert.match(
      exa,
      /args = \["-y", "mcp-remote", "https:\/\/mcp\.exa\.ai\/mcp"\]/,
    );
    assert.match(exa, /startup_timeout_sec = 30/);
    assert.doesNotMatch(exa, /^\s*url\s*=/m);
    assert.match(out, /default_mode_request_user_input = true/);
  });
});
