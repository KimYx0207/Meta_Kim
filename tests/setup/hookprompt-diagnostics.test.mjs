import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, linkSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildHookPromptAdapterSource } from "../../scripts/runtime-hook-mapping.mjs";
import { collectHookPromptDiagnostics } from "../../scripts/hookprompt-diagnostics.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-prompt-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const homes = Object.fromEntries(["claude", "codex", "cursor", "openclaw"].map((runtime) => [runtime, path.join(root, runtime)]));
  for (const home of Object.values(homes)) mkdirSync(path.join(home, "hooks"), { recursive: true });
  const adapter = path.join(homes.codex, "hooks/hookprompt-adapter.mjs");
  writeFileSync(adapter, buildHookPromptAdapterSource("codex"));
  writeFileSync(path.join(homes.codex, "hooks/user-prompt-submit.js"), "// unknown implementation; must not run\nthrow new Error('must not execute');\n");
  writeFileSync(path.join(homes.codex, "hooks/hookprompt-display.json"), '{"mode":"full"}');
  writeFileSync(path.join(homes.codex, "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `node "${adapter}"` }] }] } }));
  const env = { ...process.env, HOME: root, USERPROFILE: root, HOOKPROMPT_DISPLAY_MODE: "", ...Object.fromEntries(Object.entries(homes).map(([runtime, home]) => [`META_KIM_${runtime.toUpperCase()}_HOME`, home])) };
  return { root, homes, adapter, env };
}

test("public ordinary status exposes HookPrompt source and per-runtime display instead of hiding it in JSON", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, ["bin/meta-kim.mjs", "status", "--scope=global", "--lang", "zh"], { cwd: repoRoot, env: f.env, encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /HookPrompt/u);
  assert.match(result.stdout, /codex/u);
  assert.match(result.stdout, /full/u);
  assert.match(result.stdout, /user-prompt-submit\.js/u);
});

const displaySnippet = `function buildOptimizationRequest(template, userInput) {
 const useCompactContext = process.env.HOOKPROMPT_COMPACT_CONTEXT === '1';
 const useFullDisplay = process.env.HOOKPROMPT_DISPLAY_MODE === 'full';
 const forceInstruction = useFullDisplay
   ? (useCompactContext ? buildCompactInstruction(userInput) : buildFullTemplateInstruction(template, userInput))
   : [buildSummaryInstruction(userInput), useCompactContext ? '' : template].filter(Boolean).join('\\n');
 return forceInstruction;
}`;
const supportedFixture = (name) => readFileSync(path.join(repoRoot, "tests/fixtures/hookprompt-supported", name), "utf8");
const knownInner = supportedFixture("implementation.cjs");
const readReport = (f, environment = f.env) => collectHookPromptDiagnostics({ homes: f.homes, environment, projectRoot: f.root, scope: "global" });
const codexHook = (report) => report.runtimes.find((item) => item.runtime === "codex").hooks[0];
function addKnownInner(f) { writeFileSync(path.join(f.homes.codex, "hooks/user-prompt-submit.js"), knownInner); }

test("SEC-2 comment text cannot prove effective display behavior", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.homes.codex, "hooks/user-prompt-submit.js"), `/* ${displaySnippet} */\nthrow new Error('unrelated hook');`);
  const observed = codexHook(readReport(f));
  assert.equal(observed.requestedMode, "full");
  assert.equal(observed.effectiveMode, "unknown");
  assert.equal(observed.modeBranchRecognized, false);
});

test("environment overrides adjacent preference, then recognized inner default; no host preference is changed", (t) => {
  const f = fixture(t);
  addKnownInner(f);
  const preference = path.join(f.homes.codex, "hooks/hookprompt-display.json");
  const before = readFileSync(preference, "utf8");
  assert.equal(codexHook(readReport(f)).effectiveMode, "full");
  const override = codexHook(readReport(f, { ...f.env, HOOKPROMPT_DISPLAY_MODE: "summary" }));
  assert.equal(override.effectiveMode, "summary");
  assert.equal(override.modeSource, "environment");
  assert.equal(readFileSync(preference, "utf8"), before);
  writeFileSync(preference, '{"mode":"summary"}');
  assert.equal(codexHook(readReport(f)).effectiveMode, "summary");
  unlinkSync(preference);
  const fallback = codexHook(readReport(f));
  assert.equal(fallback.effectiveMode, "summary");
  assert.equal(fallback.modeSource, "inner_default");
  assert.equal(fallback.sourceOrigin, "unknown");
  assert.equal(fallback.sourceVersion, "unknown");
});

test("malformed, invalid, oversized and linked preferences are rejected without a write or hook execution", (t) => {
  const f = fixture(t);
  addKnownInner(f);
  const preference = path.join(f.homes.codex, "hooks/hookprompt-display.json");
  for (const [text, status] of [["{", "malformed"], ['{"mode":"verbose"}', "invalid_mode"], ['{"mode":"full","padding":"' + "x".repeat(4096) + '"}', "oversized"]]) {
    writeFileSync(preference, text);
    const result = codexHook(readReport(f));
    assert.equal(result.preferenceStatus, status);
    assert.equal(result.effectiveMode, "summary");
    assert.equal(readFileSync(preference, "utf8"), text);
  }
  unlinkSync(preference);
  const owned = path.join(f.root, "user-owned-preference.json");
  writeFileSync(owned, '{"mode":"full"}');
  linkSync(owned, preference);
  assert.equal(codexHook(readReport(f)).preferenceStatus, "linked_or_nonfile");
  assert.equal(codexHook(readReport(f)).effectiveMode, "summary");
  assert.equal(readFileSync(owned, "utf8"), '{"mode":"full"}');
});

test("missing and unrecognized hooks remain unknown; an earlier rejected candidate never falls through to a different source", (t) => {
  const f = fixture(t);
  let hook = codexHook(readReport(f));
  assert.equal(hook.requestedMode, "full");
  assert.equal(hook.effectiveMode, "unknown");
  const source = path.join(f.homes.codex, "hooks/user-prompt-submit.js");
  unlinkSync(source);
  assert.equal(codexHook(readReport(f)).sourceStatus, "missing");
  mkdirSync(source);
  mkdirSync(path.join(f.homes.codex, "hooks/hookprompt"));
  writeFileSync(path.join(f.homes.codex, "hooks/hookprompt/user-prompt-submit.js"), knownInner);
  hook = codexHook(readReport(f));
  assert.equal(hook.sourceStatus, "linked_or_nonfile");
  assert.equal(hook.sourceFile, source);
  writeFileSync(f.adapter, "throw new Error('unknown adapter must not run');");
  hook = codexHook(readReport(f));
  assert.equal(hook.sourceStatus, "unrecognized_adapter");
  assert.equal(hook.sourceFile, null);
});

test("multiple native entries and different runtime modes stay separate", (t) => {
  const f = fixture(t);
  addKnownInner(f);
  const direct = path.join(f.homes.claude, "hooks/user-prompt-submit.js");
  writeFileSync(direct, knownInner);
  writeFileSync(path.join(f.homes.claude, "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [
    { type: "command", command: `node "${direct}"` }, { type: "command", command: `node "${direct}"` },
  ] }] } }));
  const cursorAdapter = path.join(f.homes.cursor, "hooks/hookprompt-adapter.mjs");
  writeFileSync(cursorAdapter, buildHookPromptAdapterSource("cursor"));
  writeFileSync(path.join(f.homes.cursor, "hooks/user-prompt-submit.js"), knownInner);
  writeFileSync(path.join(f.homes.cursor, "hooks/hookprompt-display.json"), '{"mode":"summary"}');
  writeFileSync(path.join(f.homes.cursor, "hooks.json"), JSON.stringify({ hooks: { beforeSubmitPrompt: [{ command: `node "${cursorAdapter}"` }] } }));
  const report = readReport(f);
  const claude = report.runtimes.find((item) => item.runtime === "claude");
  assert.equal(claude.state, "multiple");
  assert.equal(claude.hooks.length, 2);
  assert.equal(claude.hooks[0].effectiveMode, "summary");
  assert.equal(codexHook(report).effectiveMode, "full");
  assert.equal(report.runtimes.find((item) => item.runtime === "cursor").hooks[0].effectiveMode, "summary");
  assert.equal(report.runtimes.find((item) => item.runtime === "openclaw").state, "declarative_only");
});

test("dual-module shim exposes its inner source without executing either and diagnostics remain read-only", (t) => {
  const f = fixture(t);
  const marker = path.join(f.root, "executed.txt");
  writeFileSync(path.join(f.homes.codex, "hooks/user-prompt-submit.js"), supportedFixture("claude-entry.js"));
  writeFileSync(path.join(f.homes.codex, "hooks/user-prompt-submit.cjs"), knownInner);
  const before = readdirSync(f.root, { recursive: true }).sort();
  const hook = codexHook(readReport(f));
  assert.equal(hook.effectiveMode, "full");
  assert.match(hook.implementationFile, /user-prompt-submit\.cjs$/u);
  assert.match(hook.implementationSha256, /^[a-f0-9]{64}$/u);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(readdirSync(f.root, { recursive: true }).sort(), before);
  assert.equal(existsSync(path.join(f.root, ".meta-kim/runtime/projection-packages")), false);
});

test("Codex stdin-only shim resolves its exact relative implementation", (t) => {
  const f = fixture(t);
  const entry = path.join(f.homes.codex, "hooks/user-prompt-submit.js");
  writeFileSync(entry, supportedFixture("codex-entry.js"));
  const implementation = path.resolve(path.dirname(entry), "../../.claude/hooks/user-prompt-submit.cjs");
  mkdirSync(path.dirname(implementation), { recursive: true });
  writeFileSync(implementation, knownInner);
  const observed = codexHook(readReport(f));
  assert.equal(observed.implementationFile, implementation);
  assert.equal(observed.effectiveMode, "full");
});

test("SEC-2 quoted/template snippets, arbitrary changes and spoofed shims stay unknown without execution", (t) => {
  const f = fixture(t);
  const source = path.join(f.homes.codex, "hooks/user-prompt-submit.js");
  const marker = path.join(f.root, "untrusted-hook-ran.txt");
  const mutation = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');`;
  for (const text of [
    `const text = ${JSON.stringify(displaySnippet)}; throw new Error('unrelated');`,
    'const text = `' + displaySnippet + '`; throw new Error("unrelated");',
    `/* require('./user-prompt-submit.cjs'); import('./user-prompt-submit.cjs'); */ ${mutation}`,
    knownInner + '\n' + mutation,
    mutation + '\n' + knownInner,
    displaySnippet,
  ]) {
    writeFileSync(source, text);
    writeFileSync(path.join(f.homes.codex, "hooks/user-prompt-submit.cjs"), knownInner);
    const observed = codexHook(readReport(f));
    assert.equal(observed.requestedMode, "full");
    assert.equal(observed.effectiveMode, "unknown");
    assert.equal(observed.modeEvidence, "unproven_inner_behavior");
    assert.equal(existsSync(marker), false);
  }
});

test("supported complete source and shims remain portable across LF and CRLF", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.homes.codex, "hooks/user-prompt-submit.js"), supportedFixture("claude-entry.js").replace(/\n/gu, "\r\n"));
  writeFileSync(path.join(f.homes.codex, "hooks/user-prompt-submit.cjs"), knownInner.replace(/\n/gu, "\r\n"));
  const observed = codexHook(readReport(f));
  assert.equal(observed.effectiveMode, "full");
  assert.equal(observed.modeEvidence, "reviewed_source_fingerprint");
});

test("status JSON and doctor hooks expose the same diagnostics without modifying settings", (t) => {
  const f = fixture(t);
  addKnownInner(f);
  const before = readdirSync(f.root, { recursive: true }).sort();
  const json = spawnSync(process.execPath, ["bin/meta-kim.mjs", "status", "--scope=global", "--json"], { cwd: repoRoot, env: f.env, encoding: "utf8", timeout: 20000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(codexHook(JSON.parse(json.stdout).hookPrompt).effectiveMode, "full");
  const doctor = spawnSync(process.execPath, ["bin/meta-kim.mjs", "doctor", "hooks", "--all", "--project-root", f.root, "--lang", "zh"], { cwd: repoRoot, env: f.env, encoding: "utf8", timeout: 20000 });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /HookPrompt/u);
  assert.match(doctor.stdout, /显示模式=full/u);
  assert.deepEqual(readdirSync(f.root, { recursive: true }).sort(), before);
});
