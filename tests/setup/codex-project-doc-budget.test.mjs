import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as codexConfigMerge from "../../scripts/codex-config-merge.mjs";

const {
  ensureCodexAppNativeControls,
  invertCodexConfigMutations,
  planCodexAppNativeControls,
  removeMetaKimTemporaryProjectResidue,
} = codexConfigMerge;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const options = { platformName: "linux" };
const KEY = "project_doc_max_bytes";

function rootAssignments(configText, key) {
  const lines = String(configText).split(/\r\n|\n|\r/u);
  const firstTable = lines.findIndex((line) => /^\s*\[/u.test(line));
  return lines
    .slice(0, firstTable < 0 ? lines.length : firstTable)
    .filter((line) => new RegExp(`^\\s*${key}\\s*=`, "u").test(line));
}

describe("Codex project-doc budget native control", () => {
  test("the shipped budget keeps the user's native Codex allowance on top of the Meta_Kim entry", () => {
    const builtin = codexConfigMerge.CODEX_BUILTIN_PROJECT_DOC_MAX_BYTES;
    const shipped = codexConfigMerge.CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES;
    assert.equal(builtin, 32768, "Codex CLI built-in project_doc_max_bytes");
    assert.ok(Number.isInteger(shipped) && shipped > builtin);

    // Codex concatenates AGENTS.md from the project root down to cwd against a
    // single budget. Project bootstrap appends this whole file to the user's
    // AGENTS.md as a managed block, so the budget must fit the entry plus the
    // allowance the user had before installing Meta_Kim.
    const entryBytes = readFileSync(path.join(repoRoot, "AGENTS.md")).length;
    assert.ok(
      entryBytes + builtin <= shipped,
      `AGENTS.md is ${entryBytes} bytes; with the ${builtin}-byte native allowance it exceeds ` +
        `${KEY} = ${shipped}. Trim AGENTS.md or raise CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES.`,
    );
  });

  test("the copyable config example carries the same budget", () => {
    const example = readFileSync(
      path.join(repoRoot, "canonical", "runtime-assets", "codex", "config.toml.example"),
      "utf8",
    );
    assert.deepEqual(rootAssignments(example, KEY), [
      `${KEY} = ${codexConfigMerge.CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES}`,
    ]);
  });

  test("an unset budget is inserted as a root key and journaled for exact inversion", () => {
    const expectedLine = `${KEY} = ${codexConfigMerge.CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES}`;
    for (const input of [
      "",
      'model = "gpt-5.5"',
      'model = "gpt-5.5"\n',
      'model = "gpt-5.5"\r\n\r\n[features]\r\njs_repl = true\r\n',
      "[features]\ndefault_mode_request_user_input = true\njs_repl = true\n\n[agents]\nmax_threads = 2\nmax_depth = 1\n",
      // A same-named key inside a table is not the root budget.
      `[profiles.small]\n${KEY} = 1024\n`,
      // An array-of-tables header ends the root table just like a plain one.
      '[[skills.config]]\npath = "a"\nenabled = false\n',
      'model = "gpt-5.5"\n\n[[skills.config]]\npath = "a"\n\n[features]\njs_repl = true\n',
      `[[skills.config]]\n${KEY} = 1\n`,
    ]) {
      const planned = planCodexAppNativeControls(input, options);
      assert.deepEqual(rootAssignments(planned.text, KEY), [expectedLine], JSON.stringify(input));
      assert.deepEqual(
        rootAssignments(ensureCodexAppNativeControls(input, options), KEY),
        [expectedLine],
        JSON.stringify(input),
      );
      const journal = JSON.parse(JSON.stringify(planned.mutations));
      const owned = journal.filter((mutation) => mutation.locator.key === KEY);
      assert.equal(owned.length, 1, JSON.stringify(input));
      assert.equal(owned[0].kind, "insert");
      assert.equal(owned[0].locator.table, "");
      assert.equal(invertCodexConfigMutations(planned.text, journal), input, JSON.stringify(input));
    }
  });

  test("section defaults never land inside a following array-of-tables element", () => {
    const tail = '[[skills.config]]\npath = "a"\nenabled = false\n';
    const input = [
      `${KEY} = 65536`,
      "",
      "[features]",
      "default_mode_request_user_input = true",
      "js_repl = true",
      "",
      "[agents]",
      "max_depth = 1",
      "",
      tail,
    ].join("\n");
    const planned = planCodexAppNativeControls(input, options);
    for (const text of [planned.text, ensureCodexAppNativeControls(input, options)]) {
      assert.ok(text.endsWith(tail), text);
      assert.ok(text.indexOf("max_threads = 2") < text.indexOf("[[skills.config]]"), text);
    }
    assert.equal(
      invertCodexConfigMutations(planned.text, JSON.parse(JSON.stringify(planned.mutations))),
      input,
    );
  });

  test("a quoted root key is the same user-owned budget and is never duplicated", () => {
    for (const quotedKey of [`"${KEY}"`, `'${KEY}'`]) {
      const input = [
        `${quotedKey} = 10`,
        "",
        "[features]",
        "default_mode_request_user_input = true",
        "js_repl = true",
        "",
        "[agents]",
        "max_threads = 2",
        "max_depth = 1",
        "",
      ].join("\n");
      const planned = planCodexAppNativeControls(input, options);
      assert.equal(planned.text, input, quotedKey);
      assert.deepEqual(planned.mutations, [], quotedKey);
      assert.equal(ensureCodexAppNativeControls(input, options), input, quotedKey);
    }
  });

  test("an existing budget is user-owned whether smaller, larger, or disabled", () => {
    for (const value of ["0", "16384", "1048576 # monorepo"]) {
      const input = [
        `${KEY} = ${value}`,
        "",
        "[features]",
        "default_mode_request_user_input = true",
        "js_repl = true",
        "",
        "[agents]",
        "max_threads = 2",
        "max_depth = 1",
        "",
      ].join("\n");
      const planned = planCodexAppNativeControls(input, options);
      assert.equal(planned.text, input, value);
      assert.deepEqual(planned.mutations, [], value);
      assert.equal(ensureCodexAppNativeControls(input, options), input, value);
    }
  });
});

describe("Codex config array-of-tables boundaries", () => {
  const arrayTable = '[[skills.config]]\npath = "a"\nenabled = false\n';

  test("temporary project residue cleanup stops at a following array of tables", () => {
    const input = [
      "[projects.'C:/Temp/meta-kim-harness-fitness-lab-workspaces/run/trial']",
      'trust_level = "trusted"',
      "",
      arrayTable,
    ].join("\n");
    const out = removeMetaKimTemporaryProjectResidue(input);
    assert.doesNotMatch(out, /harness-fitness-lab-workspaces/u);
    assert.ok(out.endsWith(arrayTable), out);
  });

  test("uninstall removes a table Meta_Kim inserted even when the user appended an array of tables", () => {
    const input = [
      `${KEY} = 65536`,
      "",
      "[features]",
      "default_mode_request_user_input = true",
      "js_repl = true",
      "",
    ].join("\n");
    const planned = planCodexAppNativeControls(input, options);
    assert.match(planned.text, /\[agents\]/u);
    const userEdited = `${planned.text}\n${arrayTable}`;
    assert.equal(
      invertCodexConfigMutations(userEdited, planned.mutations),
      `${input}\n${arrayTable}`,
    );
  });

  test("a removed table key is restored into its own table, not a following array element", () => {
    const journal = [{
      kind: "remove",
      locator: { table: "agents", key: "max_threads" },
      beforeFragment: "max_threads = 2\n",
      afterFragment: "",
    }];
    assert.equal(
      invertCodexConfigMutations(`[agents]\nmax_depth = 1\n${arrayTable}`, journal),
      `[agents]\nmax_depth = 1\nmax_threads = 2\n${arrayTable}`,
    );
  });

  test("a removed root key is restored before a leading array of tables", () => {
    const journal = [{
      kind: "remove",
      locator: { table: "", key: "notify" },
      beforeFragment: 'notify = ["x"]\n',
      afterFragment: "",
    }];
    assert.equal(
      invertCodexConfigMutations(arrayTable, journal),
      `notify = ["x"]\n${arrayTable}`,
    );
  });
});
