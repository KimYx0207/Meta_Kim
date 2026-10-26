import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderHookPromptDiagnostics } from "../../scripts/hookprompt-diagnostics.mjs";
import * as localeResources from "../../scripts/meta-kim-i18n.mjs";

const report = {
  runtimes: [
    { runtime: "codex", scope: "global", hooks: [{
      effectiveMode: "unknown", requestedMode: "full", modeSource: "adjacent_preference",
      sourceFile: "C:/example/hooks/user-prompt-submit.js", sourceStatus: "read",
      implementationFile: "C:/example/hooks/user-prompt-submit.cjs",
      sourceOrigin: "unknown", sourceVersion: "unknown", implementationSha256: "sha-proof",
      preferencePath: "C:/example/hooks/hookprompt-display.json", preferenceStatus: "malformed",
    }] },
    { runtime: "openclaw", scope: "global", state: "declarative_only", settingsStatus: "read", hooks: [] },
    { runtime: "claude", scope: "project", hooks: [
      { effectiveMode: "summary", modeSource: "inner_default", sourceStatus: "missing", sourceOrigin: "unknown", sourceVersion: "unknown" },
      { effectiveMode: "full", modeSource: "environment", sourceStatus: "read", sourceOrigin: "unknown", sourceVersion: "unknown" },
    ] },
  ],
};

test("HookPrompt diagnostic copy is available through the shared locale resource getter", () => {
  assert.equal(typeof localeResources.getHookPromptDiagnosticsCopy, "function");
  const getCopy = localeResources.getHookPromptDiagnosticsCopy;
  assert.equal(getCopy("zh").display, "显示模式");
  assert.equal(getCopy("en").display, "display");
  assert.deepEqual(getCopy("unsupported"), getCopy("en"));
});

test("HookPrompt diagnostic zh/en text preserves unknown, requested mode and evidence values", () => {
  const before = structuredClone(report);
  const zh = renderHookPromptDiagnostics(report, "zh-CN");
  const en = renderHookPromptDiagnostics(report, "en");
  assert.match(zh, /覆盖顺序：环境变量 > 适配器旁显示偏好 > 内层默认/u);
  assert.match(zh, /显示模式=unknown \(适配器旁偏好; 配置要求=full\)/u);
  assert.match(en, /display=unknown \(adjacent_preference; requested=full\)/u);
  assert.match(zh, /未确认配置或无原生入口 \(declarative_only; read\)/u);
  assert.match(en, /no confirmed native entry \(declarative_only; read\)/u);
  assert.match(zh, /发现多个入口，不能选定唯一来源/u);
  assert.match(en, /multiple entries; no unique source/u);
  assert.match(zh, /显示模式=summary \(内层默认\)/u);
  assert.match(en, /display=full \(environment\)/u);
  for (const output of [zh, en]) {
    assert.ok(output.includes("C:/example/hooks/user-prompt-submit.js [read]"));
    assert.ok(output.includes("C:/example/hooks/user-prompt-submit.cjs"));
    assert.ok(output.includes("unknown / unknown; SHA256=sha-proof"));
    assert.ok(output.includes("C:/example/hooks/hookprompt-display.json [malformed]"));
  }
  assert.deepEqual(report, before);
});

test("HookPrompt renderer obtains foreground copy from resources and leaves source unchanged", () => {
  const sourceUrl = new URL("../../scripts/hookprompt-diagnostics.mjs", import.meta.url);
  const before = readFileSync(sourceUrl, "utf8");
  const renderer = before.slice(before.indexOf("export function renderHookPromptDiagnostics"));
  assert.match(renderer, /getHookPromptDiagnosticsCopy\(language\)/u);
  assert.doesNotMatch(renderer, /覆盖顺序|配置要求|no confirmed native entry|multiple entries; no unique source/u);
  renderHookPromptDiagnostics(report, "zh-CN");
  renderHookPromptDiagnostics(report, "en");
  assert.equal(readFileSync(sourceUrl, "utf8"), before);
});
