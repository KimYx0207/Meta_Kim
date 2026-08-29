import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { pythonCandidates } from "../../scripts/graphify-runtime.mjs";
import {
  findskillPackSubdirForPlatform,
  resolveManifestSkillSubdir,
  shouldUseCliShell,
} from "../../scripts/install-platform-config.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const skillsManifest = JSON.parse(
  readFileSync(path.join(repoRoot, "config", "skills.json"), "utf8"),
);
const findskillSkill = skillsManifest.skills.find((skill) => skill.id === "findskill");
const hookPromptSkill = skillsManifest.skills.find((skill) => skill.id === "hookprompt");
const superpowersSkill = skillsManifest.skills.find(
  (skill) => skill.id === "superpowers",
);
const eccSkill = skillsManifest.skills.find((skill) => skill.id === "ecc");

describe("install platform config", () => {
  test("quick deploy copies root runtime guide files", () => {
    const source = readFileSync(path.join(repoRoot, "setup.mjs"), "utf8");
    const deployMatch = source.match(
      /function deployPlatformFiles\(platformId, targetDir\) \{[\s\S]*?\n\}/,
    );
    const rootsMatch = source.match(
      /function projectDeployRootsForPlatform\(platformId\) \{[\s\S]*?\n\}/,
    );
    assert.ok(deployMatch, "deployPlatformFiles body not found");
    assert.ok(rootsMatch, "projectDeployRootsForPlatform body not found");
    const deployBody = deployMatch[0];
    const rootsBody = rootsMatch[0];

    assert.match(deployBody, /projectDeployRootsForPlatform\(platformId\)/);
    assert.match(rootsBody, /add\("CLAUDE\.md"\)/);
    assert.match(rootsBody, /add\("AGENTS\.md"\)/);
    assert.match(rootsBody, /platformId === "claude" \|\| platformId === "all"/);
    assert.match(rootsBody, /platformId === "openclaw"/);
    assert.match(rootsBody, /platformId === "codex"/);
    assert.match(rootsBody, /platformId === "cursor"/);
    assert.match(
      rootsBody,
      /add\("canonical\/skills\/meta-theory", "\.agents\/skills\/meta-theory"\)/,
    );
    assert.doesNotMatch(rootsBody, /add\("\.codex\/skills"\)/);
    assert.equal(
      rootsBody.match(/add\("AGENTS\.md"\)/g)?.length,
      1,
    );
  });

  test("findskill uses windows subdir on Windows", () => {
    assert.equal(findskillPackSubdirForPlatform("win32"), "windows");
    assert.equal(resolveManifestSkillSubdir(findskillSkill, "win32"), "windows");
  });

  test("findskill uses original subdir on macOS and Linux", () => {
    assert.equal(findskillPackSubdirForPlatform("darwin"), "original");
    assert.equal(findskillPackSubdirForPlatform("linux"), "original");
    assert.equal(resolveManifestSkillSubdir(findskillSkill, "darwin"), "original");
    assert.equal(resolveManifestSkillSubdir(findskillSkill, "linux"), "original");
  });

  test("HookPrompt declares global-capable Codex and Cursor adapters", () => {
    assert.equal(hookPromptSkill.platformSupport.codex.adapter, "codex-hookprompt-adapter");
    assert.equal(hookPromptSkill.platformSupport.cursor.adapter, "cursor-hookprompt-adapter");
    assert.equal(hookPromptSkill.platformSupport.codex.events[0], "UserPromptSubmit");
    assert.equal(hookPromptSkill.platformSupport.cursor.events[0], "beforeSubmitPrompt");
  });

  test("superpowers declares native Codex and Cursor plugin flows", () => {
    assert.equal(superpowersSkill.installMethod, "pluginMarketplace");
    assert.equal(superpowersSkill.claudePlugin, "superpowers@superpowers-marketplace");
    assert.equal(superpowersSkill.codexPlugin, "superpowers");
    assert.equal(superpowersSkill.cursorPlugin, "superpowers");
  });

  test("ECC uses current upstream repo and native installer policy", () => {
    assert.equal(eccSkill.repo, "affaan-m/ECC");
    assert.equal(eccSkill.claudePlugin, "ecc@ecc");
    assert.equal(eccSkill.installMethod, "upstreamCli");
    assert.equal(eccSkill.upstreamPackage, "ecc-universal@latest");
    assert.equal(eccSkill.upstreamProfile, "core");
    assert.deepEqual(eccSkill.legacyNames, ["everything-claude-code"]);
    assert.equal(eccSkill.platformSupport.codex.status, "native");
    assert.equal(eccSkill.platformSupport.cursor.status, "native");
    assert.equal(eccSkill.platformSupport.zed.status, "native");
    assert.equal(eccSkill.platformSupport.gemini.status, "native");
    assert.equal(eccSkill.platformSupport.qwen.status, "native");
    assert.ok(eccSkill.targets.includes("codex"));
    assert.ok(eccSkill.targets.includes("cursor"));
    assert.ok(eccSkill.targets.includes("opencode"));
    assert.equal(eccSkill.targets.includes("qoder"), false);
  });

  test("legacy setup fallback only applies when requested", () => {
    const plainSkill = { id: "plain-skill" };
    assert.equal(resolveManifestSkillSubdir(plainSkill, "linux"), undefined);
    assert.equal(
      resolveManifestSkillSubdir(plainSkill, "linux", {
        fallbackToFindskillPack: true,
      }),
      "original",
    );
    assert.equal(
      resolveManifestSkillSubdir(plainSkill, "win32", {
        fallbackToFindskillPack: true,
      }),
      "windows",
    );
  });

  test("Claude CLI shell bridge is enabled only on Windows", () => {
    assert.equal(shouldUseCliShell("win32"), true);
    assert.equal(shouldUseCliShell("darwin"), false);
    assert.equal(shouldUseCliShell("linux"), false);
  });

  test("Codex dependency updates restore the user snapshot without importing upstream MCP or project state", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "install-global-skills-all-runtimes.mjs"),
      "utf8",
    );
    const restoreFunction = source.match(
      /async function restoreCodexConfigAfterUpstream[\s\S]*?\n}\n/,
    )?.[0];

    assert.ok(restoreFunction);
    assert.match(restoreFunction, /reconcileCodexConfigAfterUpstreamInstall/);
    assert.doesNotMatch(restoreFunction, /mergeCodexConfigAddOnly/);
    assert.doesNotMatch(restoreFunction, /snapshot\.text === null\) return false/);
  });

  test("two-phase global skill installs still deploy prompt hooks", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "install-global-skills-all-runtimes.mjs"),
      "utf8",
    );
    const hookSupportFunction = source.match(
      /async function deployRuntimeHookSupport[\s\S]*?\n}\n/,
    )?.[0];
    const twoPhaseFunction = source.match(
      /async function installSkillsToMultipleRuntimes[\s\S]*?async function main/,
    )?.[0];

    assert.ok(hookSupportFunction);
    assert.match(hookSupportFunction, /patchCodexHookPromptForPlatform/);
    assert.match(hookSupportFunction, /mergeHookSettings/);
    assert.match(
      source,
      /if \(!\["codex", "cursor"\]\.includes\(runtimeId\) \|\| spec\.id !== "hookprompt"/,
    );
    assert.ok(twoPhaseFunction);
    assert.match(twoPhaseFunction, /deployRuntimeHookSupport\(spec, runtimeHome, runtimeId, skillsRoot\)/);
    assert.match(
      twoPhaseFunction,
      /deployRuntimeHookSupport\(spec, runtimeHome, runtimeId, skillsRoot\);[\s\S]*cleanupDisabledSkillResidue/,
    );
  });
});

describe("python launcher selection", () => {
  test("Windows automatic detection uses only discovered absolute executables", () => {
    assert.deepEqual(pythonCandidates("win32"), []);
  });

  test("macOS and Linux prefer python3 first", () => {
    const expected = [
      { command: "python3", args: [] },
      { command: "python", args: [] },
    ];
    assert.deepEqual(pythonCandidates("darwin").slice(0, 2), expected);
    assert.deepEqual(pythonCandidates("linux").slice(0, 2), expected);
  });
});
