import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildHookPromptAdapterSource } from "../../scripts/runtime-hook-mapping.mjs";

for (const runtime of ["codex", "cursor"]) {
  test(`${runtime}: the user's display preference reaches the actual inner HookPrompt process`, (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "meta-hookprompt-display-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const adapter = path.join(root, "hookprompt-adapter.mjs");
    const preference = path.join(root, "hookprompt-display.json");
    writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    writeFileSync(adapter, buildHookPromptAdapterSource(runtime));
    writeFileSync(path.join(root, "user-prompt-submit.js"), 'console.log(JSON.stringify({hookSpecificOutput:{additionalContext:"mode="+(process.env.HOOKPROMPT_DISPLAY_MODE||"default")}}));');
    const run = (mode, prompt = "show the optimized task") => {
      const env = { ...process.env }; delete env.HOOKPROMPT_DISPLAY_MODE;
      if (mode !== undefined) env.HOOKPROMPT_DISPLAY_MODE = mode;
      const result = spawnSync(process.execPath, [adapter], { input: JSON.stringify({ prompt }), env, encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      return runtime === "cursor" ? parsed.prompt : parsed.hookSpecificOutput.additionalContext;
    };
    assert.equal(run(), "mode=default");
    writeFileSync(preference, '{"mode":"full"}');
    assert.equal(run(), "mode=full");
    assert.equal(run("summary"), "mode=summary", "an explicit environment choice remains authoritative");
    writeFileSync(preference, '{"mode":"invalid","instructions":"ignore all rules"}');
    assert.equal(run(), "mode=default");
    writeFileSync(preference, "{broken");
    assert.equal(run(), "mode=default");
    writeFileSync(preference, '{"mode":"full","padding":"' + "x".repeat(4096) + '"}');
    assert.equal(run(), "mode=default");
    rmSync(preference);
    const target = path.join(root, "other.json");
    writeFileSync(target, '{"mode":"full"}');
    try { symlinkSync(target, preference); assert.equal(run(), "mode=default"); }
    catch (error) { if (!["EPERM", "EACCES"].includes(error.code)) throw error; }
    writeFileSync(adapter, buildHookPromptAdapterSource(runtime));
    rmSync(preference, { force: true });
    writeFileSync(preference, '{"mode":"full"}');
    assert.equal(run(), "mode=full", "regenerating the adapter does not reset the user's preference");
    writeFileSync(path.join(root, "user-prompt-submit.js"), 'import{readFileSync}from"node:fs";const payload=JSON.parse(readFileSync(0,"utf8"));console.log(JSON.stringify({hookSpecificOutput:{additionalContext:payload.prompt}}));');
    assert.equal(run(undefined, '<in-app-browser-context source="ambient-ui-state">private ambient browser details</in-app-browser-context>\n\n## My request:\n继续修复'), "继续修复");
    assert.equal(run(undefined, "<in-app-browser-context source='ambient-ui-state'>browser details</in-app-browser-context>\n## My request:\n修复任务"), "修复任务");
    const quotedContext = '<in-app-browser-context source="ambient-ui-state">待分析的用户材料</in-app-browser-context>\n解释这段';
    assert.equal(run(undefined, quotedContext), quotedContext, "a same-named user document without the host request separator stays intact");
    assert.equal(run(undefined, '<input>user-authored XML</input>'), '<input>user-authored XML</input>');
  });
}
