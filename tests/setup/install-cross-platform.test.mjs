import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { pythonCandidates } from "../../scripts/graphify-runtime.mjs";
import {
  findskillPackSubdirForPlatform,
  resolveManifestSkillSubdir,
  shouldUseCliShell,
} from "../../scripts/install-platform-config.mjs";
import {
  buildCodexHookRunnerMjs,
  collectWindowsPythonCandidatePaths,
} from "../../scripts/install-global-skills-all-runtimes.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const skillsManifest = JSON.parse(
  readFileSync(path.join(repoRoot, "config", "skills.json"), "utf8"),
);
const findskillSkill = skillsManifest.skills.find((skill) => skill.id === "findskill");
const planningWithFilesSkill = skillsManifest.skills.find(
  (skill) => skill.id === "planning-with-files",
);
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

  test("explicit subdir is stable across platforms", () => {
    assert.equal(
      resolveManifestSkillSubdir(planningWithFilesSkill, "win32"),
      "skills/planning-with-files",
    );
    assert.equal(
      resolveManifestSkillSubdir(planningWithFilesSkill, "darwin"),
      "skills/planning-with-files",
    );
    assert.equal(
      resolveManifestSkillSubdir(planningWithFilesSkill, "linux"),
      "skills/planning-with-files",
    );
  });

  test("planning-with-files uses skills/ as canonical + pluginHookCompat for hooks", () => {
    assert.equal(planningWithFilesSkill.pluginHookCompat, true);
    assert.equal(planningWithFilesSkill.installRoot, undefined);
  });

  test("planning-with-files is a project workflow hook, not a Meta_Kim governance hook", () => {
    assert.deepEqual(planningWithFilesSkill.globalHookSubdirs, {
      codex: ["~/.codex/hooks/meta-kim"],
      cursor: ["~/.cursor/hooks/meta-kim"],
    });
    assert.equal(planningWithFilesSkill.platformSupport, undefined);
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

  test("Codex planning hooks use Node runner on every platform", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "install-global-skills-all-runtimes.mjs"),
      "utf8",
    );
    const commandFunction = source.match(
      /function codexPlanningHookCommand[\s\S]*?\n}\n/,
    )?.[0];

    assert.ok(commandFunction);
    assert.match(commandFunction, /codex_hook_runner\.mjs/);
    assert.match(commandFunction, /process\.execPath/);
    assert.match(commandFunction, /shellToken/);
    assert.match(commandFunction, /return `\$\{shellToken\(nodePath\)\}/);
    assert.doesNotMatch(commandFunction, /os\.platform\(\) === "win32"/);
    assert.doesNotMatch(commandFunction, /return `node |return `"\$\{nodePath\}"|python3|2>\/dev\/null|\|\| true/);
  });

  test("Codex hook runner uses hidden safe Python probes and preserves fail-open I/O semantics", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "install-global-skills-all-runtimes.mjs"),
      "utf8",
    );
    const runnerBuilder = source.match(
      /(?:export )?function buildCodexHookRunnerMjs\([^)]*\) \{[\s\S]*?\n\}/,
    )?.[0];

    assert.ok(runnerBuilder);
    assert.doesNotMatch(runnerBuilder, /ProgramData|anaconda|Python311|Python313|\.openclaw/iu);
    assert.match(runnerBuilder, /META_KIM_PYTHON/);
    assert.match(runnerBuilder, /collectWindowsPythonCandidatePaths/);
    assert.match(runnerBuilder, /commandWorks/);
    assert.match(runnerBuilder, /sys\.version_info >= \(3, 10\)/);
    assert.doesNotMatch(runnerBuilder, /'--version'/);
    assert.match(runnerBuilder, /INSTALL_TIME_PYTHON_HINT/);
    assert.match(runnerBuilder, /timeout: 750/);

    const generated = buildCodexHookRunnerMjs({
      command: "C:/Windows/py.exe",
      args: ["-3"],
    });
    assert.doesNotMatch(generated, /C:\/Windows\/py\.exe|command: ['"]py['"]|args: \[['"]-3['"]\]/iu);
    assert.equal(generated.match(/windowsHide: true/g)?.length, 2);
    assert.match(generated, /readFileSync\(0, 'utf8'\)/);
    assert.match(generated, /input,/);
    assert.match(generated, /if \(result\.stdout\) process\.stdout\.write\(result\.stdout\)/);
    assert.match(generated, /timeout: 30000/);
    assert.match(generated, /const result = spawnSync[\s\S]*?return 0;/);
    assert.ok(
      generated.indexOf("command: 'python3'") < generated.indexOf("command: 'python'"),
      "macOS/Linux fallback order must remain python3 then python",
    );

    const patchFunction = source.match(
      /async function patchCodexPlanningHooksForPlatform[\s\S]*?\n}\n/,
    )?.[0];
    assert.ok(patchFunction);
    assert.match(
      patchFunction,
      /process\.platform === "win32" \? null : detectPython310\(\)/,
    );
  });

  test("Codex Windows Python discovery prefers env and finds off-PATH installs", () => {
    const envPython = "D:\\EnvPython\\python.exe";
    const pathPython = "D:\\PathPython\\python.exe";
    const offPathPython = "D:\\Local\\Programs\\Python\\Python314\\python.exe";
    const offPathPython32 = "D:\\Local\\Programs\\Python\\Python314-32\\python.exe";
    const existing = new Set(
      [envPython, pathPython, offPathPython, offPathPython32]
        .map((value) => value.toLowerCase()),
    );
    const candidates = collectWindowsPythonCandidatePaths({
      env: {
        META_KIM_PYTHON: envPython,
        PYTHON: "C:\\Windows\\py.exe",
        PATH: "D:\\PathPython",
        LOCALAPPDATA: "D:\\Local",
      },
      installTimeHint: { command: "D:\\HintPython\\python.exe", args: [] },
      pathApi: path.win32,
      pathExists: (candidate) => existing.has(candidate.toLowerCase()),
      listDirectoryNames: (directory) =>
        directory.toLowerCase() === "d:\\local\\programs\\python"
          ? ["Python314", "Python314-32"]
          : [],
    });

    assert.deepEqual(candidates, [envPython, pathPython, offPathPython, offPathPython32]);
    assert.equal(candidates.some((candidate) => /(?:^|[\\/])py\.exe$/iu.test(candidate)), false);
  });

  test(
    "Codex hook runner rejects a stale explicit interpreter and uses a live fallback",
    { skip: process.platform !== "win32" },
    (context) => {
      const wherePython = spawnSync("where.exe", ["python"], {
        encoding: "utf8",
        windowsHide: true,
      });
      const pythonCandidates = wherePython.stdout
        ?.split(/\r?\n/u)
        .map((value) => value.trim())
        .filter(Boolean) || [];
      const actualPython = pythonCandidates.find((candidate) => {
        const check = spawnSync(
          candidate,
          ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"],
          { encoding: "utf8", windowsHide: true },
        );
        return check.status === 0;
      });
      if (!actualPython) {
        context.skip("Python 3.10+ is not available for the Windows runtime probe");
        return;
      }

      const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-python-probe-"));
      try {
        const runnerPath = path.join(tempDir, "codex_hook_runner.mjs");
        const adapterPath = path.join(tempDir, "adapter.py");
        writeFileSync(
          runnerPath,
          buildCodexHookRunnerMjs({ command: actualPython, args: [] }),
          "utf8",
        );
        writeFileSync(
          adapterPath,
          'import sys\nprint("live-python-selected:" + sys.stdin.read())\n',
          "utf8",
        );

        const staleInterpreter = path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        );
        const result = spawnSync(process.execPath, [runnerPath, adapterPath], {
          input: "stdin-forwarded",
          encoding: "utf8",
          windowsHide: true,
          env: {
            ...process.env,
            META_KIM_PYTHON: staleInterpreter,
            PATH: path.join(process.env.SystemRoot || "C:\\Windows", "System32"),
          },
        });

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /live-python-selected:stdin-forwarded/);

        writeFileSync(adapterPath, "raise SystemExit(9)\n", "utf8");
        const childFailure = spawnSync(process.execPath, [runnerPath, adapterPath], {
          encoding: "utf8",
          windowsHide: true,
          env: {
            ...process.env,
            META_KIM_PYTHON: "C:/Windows/py.exe",
            PYTHON: "py",
            PYTHON3: actualPython,
            PATH: path.dirname(actualPython),
          },
        });
        assert.equal(childFailure.status, 0, childFailure.stderr);

        writeFileSync(adapterPath, 'print("live-python-selected")\n', "utf8");

        writeFileSync(
          runnerPath,
          buildCodexHookRunnerMjs({ command: staleInterpreter, args: [] }),
          "utf8",
        );
        const staleHintResult = spawnSync(
          process.execPath,
          [runnerPath, adapterPath],
          {
            encoding: "utf8",
            windowsHide: true,
            env: {
              ...process.env,
              META_KIM_PYTHON: "",
              PYTHON: "",
              PYTHON3: "",
              PATH: `${path.dirname(actualPython)}${path.delimiter}${path.join(
                process.env.SystemRoot || "C:\\Windows",
                "System32",
              )}`,
            },
          },
        );
        assert.equal(staleHintResult.status, 0, staleHintResult.stderr);
        assert.match(staleHintResult.stdout, /live-python-selected/);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  test("Codex planning hook adapter counts level-2 and level-3 phases", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "install-global-skills-all-runtimes.mjs"),
      "utf8",
    );
    const adapterFunction = source.match(
      /function buildCodexPlanningHookAdapterPy[\s\S]*?\n}\n/,
    )?.[0];

    assert.ok(adapterFunction);
    assert.match(adapterFunction, /"import re"/);
    assert.match(adapterFunction, /#\{2,3\}\\\\s\+Phase\\\\b/);
    assert.match(adapterFunction, /complete = max\(complete_primary, complete_inline\)/);
    assert.match(adapterFunction, /in_progress = max\(in_progress_primary, in_progress_inline\)/);
    assert.match(adapterFunction, /if total <= 0:/);
    assert.doesNotMatch(
      adapterFunction,
      /total = sum\(1 for line in lines if "### Phase" in line\)/,
    );
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

  test("Codex planning Stop hook does not block on advisory progress messages", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "install-global-skills-all-runtimes.mjs"),
      "utf8",
    );
    const stopWrapper = source.match(
      /function buildCodexStopWrapperPy[\s\S]*?\n}\n/,
    )?.[0];

    assert.ok(stopWrapper);
    assert.match(stopWrapper, /decision = result\.get\("decision"\)/);
    assert.match(stopWrapper, /adapter\.emit_json\(result\)/);
    assert.match(stopWrapper, /adapter\.emit_json\(\{"systemMessage": message\}\)/);
    assert.ok(stopWrapper.includes('if "(0/0" in message:'));
    assert.doesNotMatch(
      stopWrapper,
      /adapter\.emit_json\(\{"decision": "block", "reason": message\}\)/,
    );
  });

  test("Codex planning hook registration preserves existing hooks.json entries", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "install-global-skills-all-runtimes.mjs"),
      "utf8",
    );
    const deployFunction = source.match(
      /async function deployHookConfigFiles[\s\S]*?\n}\n\nfunction normalizeHookCommand/,
    )?.[0];
    const mergeFunction = source.match(
      /function mergeCodexPlanningHooksJson[\s\S]*?\n}\n/,
    )?.[0];
    const patchFunction = source.match(
      /async function patchCodexPlanningHooksForPlatform[\s\S]*?\n}\n/,
    )?.[0];

    assert.ok(deployFunction);
    assert.ok(mergeFunction);
    assert.ok(patchFunction);
    assert.match(deployFunction, /spec\.id === "planning-with-files"/);
    assert.match(deployFunction, /mergePlanningHookConfigFile\(srcPath, destPath\)/);
    assert.doesNotMatch(deployFunction, /await fs\.copyFile\(srcPath, destPath\);\s*console\.log/);
    assert.match(mergeFunction, /existingBlocks/);
    assert.match(mergeFunction, /missingHooks/);
    assert.match(mergeFunction, /hookCommandContains/);
    assert.match(patchFunction, /existingHooksJson/);
    assert.match(patchFunction, /mergeCodexPlanningHooksJson/);
    assert.doesNotMatch(
      patchFunction,
      /JSON\.stringify\(buildCodexPlanningHooksJson\(runtimeHome\), null, 2\)/,
    );
  });

  test("planning-with-files phase counter patch covers shell and PowerShell hooks", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "install-global-skills-all-runtimes.mjs"),
      "utf8",
    );
    const patchFunction = source.match(
      /async function patchPlanningWithFilesPhaseCounters[\s\S]*?\n}\n/,
    )?.[0];

    assert.ok(patchFunction);
    assert.match(patchFunction, /runtimeHome, "hooks", "stop\.sh"/);
    assert.match(patchFunction, /runtimeHome, "hooks", "stop\.ps1"/);
    assert.match(patchFunction, /"check-complete\.sh"/);
    assert.match(patchFunction, /"check-complete\.ps1"/);
    assert.match(patchFunction, /#\{2,3\}\[\[:space:\]\]\+Phase\\\\b/);
    assert.match(patchFunction, /\(\?m\)\^#\{2,3\}\\\\s\+Phase\\\\b/);
  });

  test("two-phase global skill installs still deploy prompt and planning hooks", () => {
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
    assert.match(hookSupportFunction, /patchCodexPlanningHooksForPlatform/);
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
