import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  createEmpty,
  directoryClosureSync,
  readManifest,
  record,
  writeManifest,
} from "../../scripts/install-manifest.mjs";
import { stripRetiredPlanningHooks } from "../../scripts/retire-planning-with-files.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const retirementScript = path.join(repoRoot, "scripts", "retire-planning-with-files.mjs");
const runtimeIds = ["claude", "codex", "cursor", "openclaw"];

function retiredCommand(wrapper) {
  return `node C:/fixture/.codex/hooks/codex_hook_runner.mjs C:/fixture/.codex/hooks/${wrapper}`;
}

test("retired Codex planning hooks are stripped without touching user hooks", () => {
  const config = {
    hooks: {
      UserPromptSubmit: [{ hooks: [
        { type: "command", command: retiredCommand("user_prompt_submit.py") },
        { type: "command", command: "node C:/user/hook.mjs" },
      ] }],
      Stop: [{ hooks: [{ type: "command", command: retiredCommand("stop.py") }] }],
    },
  };
  const stripped = stripRetiredPlanningHooks(config);
  assert.equal(stripped.hooks.UserPromptSubmit[0].hooks.length, 1);
  assert.equal(stripped.hooks.UserPromptSubmit[0].hooks[0].command, "node C:/user/hook.mjs");
  assert.equal(stripped.hooks.Stop, undefined);
});

test("deferred retirement is localized as manual work through the shared installer i18n surface", () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts", "meta-kim-i18n.mjs")).href;
  const cases = [
    ["en", /retirement deferred/u],
    ["zh-CN", /退役已暂缓/u],
    ["ja-JP", /廃止を保留/u],
    ["ko-KR", /사용 중단을 보류/u],
  ];
  for (const [language, expected] of cases) {
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import { t, installStatusClassForMessageKey } from ${JSON.stringify(moduleUrl)}; console.log(installStatusClassForMessageKey("planningRetirementPreserved")); console.log(t.planningRetirementPreserved(2, ["A", "B"]));`,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, META_KIM_LANG: language },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^manual\r?\n/u);
    assert.match(result.stdout, expected);
    assert.match(result.stdout, /A/u);
    assert.match(result.stdout, /B/u);
  }
  const installer = readFileSync(path.join(repoRoot, "scripts", "install-global-skills-all-runtimes.mjs"), "utf8");
  assert.match(installer, /t\.planningRetirementPreserved\(/u);
  assert.doesNotMatch(installer, /retirement preserved .*unverified path/u);
});

test("retirement is a no-op for a fresh install without a manifest", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-retire-planning-fresh-"));
  try {
    const homes = Object.fromEntries(runtimeIds.map((runtime) => [runtime, path.join(root, `.${runtime}`)]));
    const result = spawnSync(process.execPath, [retirementScript], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        META_KIM_CLAUDE_HOME: homes.claude,
        META_KIM_CODEX_HOME: homes.codex,
        META_KIM_CURSOR_HOME: homes.cursor,
        META_KIM_OPENCLAW_HOME: homes.openclaw,
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.removed, []);
    assert.deepEqual(payload.preserved, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserved legacy planning does not block independent skill install, update, or repeat update", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-retire-independent-update-"));
  const packageRoot = process.env.META_KIM_TEST_PACKED_ROOT || repoRoot;
  try {
    const homes = Object.fromEntries(runtimeIds.map((runtime) => [runtime, path.join(root, `.${runtime}`)]));
    const source = path.join(root, "fixture-skill");
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "SKILL.md"), "---\nname: meta-skill-creator\ndescription: Isolated installer fixture.\n---\n\nLocal test fixture.\n");
    const retained = new Map();
    for (const runtime of ["claude", "codex"]) {
      const legacy = path.join(homes[runtime], "skills", "planning-with-files");
      mkdirSync(legacy, { recursive: true });
      retained.set(path.join(legacy, "SKILL.md"), `# user-owned ${runtime} planning\n`);
    }
    const hooksDir = path.join(homes.codex, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    retained.set(path.join(hooksDir, "codex_hook_runner.mjs"), "// historical runner without current ownership markers\n");
    retained.set(path.join(hooksDir, "stop.py"), "# user-owned historical stop hook\n");
    const hookCommand = `node "${path.join(hooksDir, "codex_hook_runner.mjs")}" "${path.join(hooksDir, "stop.py")}"`;
    retained.set(path.join(homes.codex, "hooks.json"), `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: hookCommand }] }] } }, null, 2)}\n`);
    for (const [file, content] of retained) writeFileSync(file, content);
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      META_KIM_CLAUDE_HOME: homes.claude,
      META_KIM_CODEX_HOME: homes.codex,
      META_KIM_CURSOR_HOME: homes.cursor,
      META_KIM_OPENCLAW_HOME: homes.openclaw,
      META_KIM_LANG: "en",
      META_KIM_ALLOW_TEST_FIXTURES: "1",
      META_KIM_TEST_META_SKILL_SOURCE_DIR: source,
      META_KIM_SKIP_OPTIONAL_TOOLS: "1",
    };
    const installerArgs = [
      path.join(packageRoot, "scripts", "install-global-skills-all-runtimes.mjs"),
      "--targets", "claude,codex", "--skills", "meta-skill-creator",
      "--skip-plugins", "--skip-inventory-refresh",
    ];
    const beforeDryRun = directoryClosureSync(root);
    const dryRun = spawnSync(process.execPath, [...installerArgs, "--dry-run"], {
      cwd: packageRoot, encoding: "utf8", windowsHide: true, env, timeout: 30_000,
    });
    assert.equal(dryRun.status, 0, dryRun.stdout + dryRun.stderr);
    assert.deepEqual(directoryClosureSync(root), beforeDryRun, "dry-run must not write into the isolated home");
    for (const [version, extraArgs] of [["v1", []], ["v2", ["--update"]], ["v2", ["--update"]]]) {
      writeFileSync(path.join(source, "payload.txt"), `${version}\n`);
      const result = spawnSync(process.execPath, [...installerArgs, ...extraArgs], {
        cwd: packageRoot, encoding: "utf8", windowsHide: true, env, timeout: 30_000,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /retirement deferred/u);
      assert.match(result.stderr, /independent selected skills/u);
      for (const runtime of ["claude", "codex"]) {
        assert.equal(readFileSync(path.join(homes[runtime], "skills", "meta-skill-creator", "payload.txt"), "utf8"), `${version}\n`);
      }
      for (const [file, content] of retained) assert.equal(readFileSync(file, "utf8"), content, file);
      if (version === "v1") {
        // Subsequent updates see a mixed owned/unowned retirement transaction.
        // Even the proven owned copy must remain when another path is unverified.
        const skill = path.join(homes.claude, "skills", "planning-with-files");
        const closure = directoryClosureSync(skill);
        const manifestPath = path.join(root, ".meta-kim", "install-manifest.json");
        const manifest = record(readManifest(manifestPath), {
          path: skill, category: "A", kind: "dir",
          source: "install-global-skills-all-runtimes",
          purpose: "planning-with-files-global-skill",
          directoryClosureSha256: closure.sha256,
          directoryClosureEntryCount: closure.entryCount,
        });
        writeManifest(manifestPath, manifest);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unowned Codex wrapper and its hook registration are preserved atomically", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-retire-planning-unowned-hook-"));
  try {
    const homes = Object.fromEntries(runtimeIds.map((runtime) => [runtime, path.join(root, `.${runtime}`)]));
    const hooksDir = path.join(homes.codex, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const wrapperPath = path.join(hooksDir, "user_prompt_submit.py");
    writeFileSync(wrapperPath, "# user-owned wrapper\n", "utf8");
    const hooksPath = path.join(homes.codex, "hooks.json");
    const original = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{
          type: "command",
          command: `node ${path.join(hooksDir, "codex_hook_runner.mjs")} ${wrapperPath}`,
        }] }],
      },
    };
    writeFileSync(hooksPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");
    const result = spawnSync(process.execPath, [retirementScript], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        META_KIM_CLAUDE_HOME: homes.claude,
        META_KIM_CODEX_HOME: homes.codex,
        META_KIM_CURSOR_HOME: homes.cursor,
        META_KIM_OPENCLAW_HOME: homes.openclaw,
      },
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(readFileSync(wrapperPath, "utf8"), "# user-owned wrapper\n");
    assert.deepEqual(JSON.parse(readFileSync(hooksPath, "utf8")), original);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.removed, []);
    assert.ok(payload.preserved.some((entry) => entry.path === wrapperPath));
    assert.ok(payload.preserved.some((entry) => entry.path === hooksPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orphan plugin alias without an owned skill is preserved and blocks retirement", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-retire-planning-orphan-alias-"));
  try {
    const homes = Object.fromEntries(runtimeIds.map((runtime) => [runtime, path.join(root, `.${runtime}`)]));
    const userDirectory = path.join(root, "user-owned-planning");
    const alias = path.join(homes.claude, "plugins", "planning-with-files");
    mkdirSync(userDirectory, { recursive: true });
    writeFileSync(path.join(userDirectory, "KEEP.txt"), "keep\n", "utf8");
    mkdirSync(path.dirname(alias), { recursive: true });
    symlinkSync(userDirectory, alias, process.platform === "win32" ? "junction" : "dir");
    const result = spawnSync(process.execPath, [retirementScript], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        META_KIM_CLAUDE_HOME: homes.claude,
        META_KIM_CODEX_HOME: homes.codex,
        META_KIM_CURSOR_HOME: homes.cursor,
        META_KIM_OPENCLAW_HOME: homes.openclaw,
      },
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(readFileSync(path.join(alias, "KEEP.txt"), "utf8"), "keep\n");
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.removed, []);
    assert.ok(payload.preserved.some((entry) => entry.path === alias));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unowned Codex adapter pycache is preserved and blocks retirement", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-retire-planning-unowned-pycache-"));
  try {
    const homes = Object.fromEntries(runtimeIds.map((runtime) => [runtime, path.join(root, `.${runtime}`)]));
    const pycache = path.join(homes.codex, "hooks", "__pycache__");
    const cacheFile = path.join(pycache, "codex_hook_adapter.user.pyc");
    mkdirSync(pycache, { recursive: true });
    writeFileSync(cacheFile, "user-owned\n", "utf8");
    const result = spawnSync(process.execPath, [retirementScript], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        META_KIM_CLAUDE_HOME: homes.claude,
        META_KIM_CODEX_HOME: homes.codex,
        META_KIM_CURSOR_HOME: homes.cursor,
        META_KIM_OPENCLAW_HOME: homes.openclaw,
      },
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(readFileSync(cacheFile, "utf8"), "user-owned\n");
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.removed, []);
    assert.ok(payload.preserved.some((entry) => entry.path === cacheFile));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retirement refuses linked skills, plugins, and hooks parents without external writes", async (t) => {
  const runRetirement = (root, homes) => spawnSync(process.execPath, [retirementScript], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      META_KIM_CLAUDE_HOME: homes.claude,
      META_KIM_CODEX_HOME: homes.codex,
      META_KIM_CURSOR_HOME: homes.cursor,
      META_KIM_OPENCLAW_HOME: homes.openclaw,
    },
  });

  await t.test("linked skills parent", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-retire-planning-linked-skills-"));
    try {
      const homes = Object.fromEntries(runtimeIds.map((runtime) => [runtime, path.join(root, `.${runtime}`)]));
      const externalSkills = path.join(root, "external-skills");
      const skill = path.join(homes.claude, "skills", "planning-with-files");
      mkdirSync(path.join(externalSkills, "planning-with-files"), { recursive: true });
      writeFileSync(path.join(externalSkills, "planning-with-files", "KEEP.txt"), "keep\n", "utf8");
      mkdirSync(homes.claude, { recursive: true });
      symlinkSync(externalSkills, path.join(homes.claude, "skills"), process.platform === "win32" ? "junction" : "dir");
      const closure = directoryClosureSync(skill);
      let manifest = createEmpty({ scope: "global", metaKimVersion: "test" });
      manifest = record(manifest, {
        path: skill,
        category: "A",
        source: "install-global-skills-all-runtimes",
        purpose: "planning-with-files-global-skill",
        kind: "dir",
        directoryClosureSha256: closure.sha256,
        directoryClosureEntryCount: closure.entryCount,
      });
      writeManifest(path.join(root, ".meta-kim", "install-manifest.json"), manifest);
      const result = runRetirement(root, homes);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.equal(readFileSync(path.join(externalSkills, "planning-with-files", "KEEP.txt"), "utf8"), "keep\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("linked plugins parent", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-retire-planning-linked-plugins-"));
    try {
      const homes = Object.fromEntries(runtimeIds.map((runtime) => [runtime, path.join(root, `.${runtime}`)]));
      const skill = path.join(homes.claude, "skills", "planning-with-files");
      const externalPlugins = path.join(root, "external-plugins");
      mkdirSync(skill, { recursive: true });
      writeFileSync(path.join(skill, "KEEP.txt"), "keep\n", "utf8");
      mkdirSync(externalPlugins, { recursive: true });
      symlinkSync(skill, path.join(externalPlugins, "planning-with-files"), process.platform === "win32" ? "junction" : "dir");
      symlinkSync(externalPlugins, path.join(homes.claude, "plugins"), process.platform === "win32" ? "junction" : "dir");
      const closure = directoryClosureSync(skill);
      let manifest = createEmpty({ scope: "global", metaKimVersion: "test" });
      manifest = record(manifest, {
        path: skill,
        category: "A",
        source: "install-global-skills-all-runtimes",
        purpose: "planning-with-files-global-skill",
        kind: "dir",
        directoryClosureSha256: closure.sha256,
        directoryClosureEntryCount: closure.entryCount,
      });
      writeManifest(path.join(root, ".meta-kim", "install-manifest.json"), manifest);
      const result = runRetirement(root, homes);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.equal(readFileSync(path.join(skill, "KEEP.txt"), "utf8"), "keep\n");
      assert.equal(readFileSync(path.join(externalPlugins, "planning-with-files", "KEEP.txt"), "utf8"), "keep\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("linked hooks parent", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-retire-planning-linked-hooks-"));
    try {
      const homes = Object.fromEntries(runtimeIds.map((runtime) => [runtime, path.join(root, `.${runtime}`)]));
      const externalHooks = path.join(root, "external-hooks");
      mkdirSync(externalHooks, { recursive: true });
      mkdirSync(homes.codex, { recursive: true });
      symlinkSync(externalHooks, path.join(homes.codex, "hooks"), process.platform === "win32" ? "junction" : "dir");
      writeFileSync(path.join(externalHooks, "codex_hook_runner.mjs"), "collectWindowsPythonCandidatePaths\nINSTALL_TIME_PYTHON_HINT\nconst scriptPath = process.argv[2]\n", "utf8");
      writeFileSync(path.join(externalHooks, "user_prompt_submit.py"), 'import codex_hook_adapter as adapter\nadapter.run_shell_script("user-prompt-submit.sh", root)\n', "utf8");
      const hooksPath = path.join(homes.codex, "hooks.json");
      const original = {
        hooks: {
          UserPromptSubmit: [{ hooks: [{
            type: "command",
            command: `node ${path.join(homes.codex, "hooks", "codex_hook_runner.mjs")} ${path.join(homes.codex, "hooks", "user_prompt_submit.py")}`,
          }] }],
        },
      };
      writeFileSync(hooksPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");
      const result = runRetirement(root, homes);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.equal(readFileSync(path.join(externalHooks, "user_prompt_submit.py"), "utf8").includes("user-prompt-submit.sh"), true);
      assert.deepEqual(JSON.parse(readFileSync(hooksPath, "utf8")), original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("retirement removes only manifest-matching runtime copies, aliases, and owned Codex hooks", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-retire-planning-"));
  try {
    let manifest = createEmpty({ scope: "global", metaKimVersion: "test" });
    const homes = Object.fromEntries(runtimeIds.map((runtime) => [runtime, path.join(root, `.${runtime}`)]));
    for (const [runtime, runtimeHome] of Object.entries(homes)) {
      const skill = path.join(runtimeHome, "skills", "planning-with-files");
      const alias = path.join(runtimeHome, "plugins", "planning-with-files");
      mkdirSync(skill, { recursive: true });
      writeFileSync(path.join(skill, "SKILL.md"), `# retired ${runtime}\n`, "utf8");
      mkdirSync(path.dirname(alias), { recursive: true });
      symlinkSync(skill, alias, process.platform === "win32" ? "junction" : "dir");
      const closure = directoryClosureSync(skill);
      manifest = record(manifest, {
        path: skill,
        category: "A",
        source: "install-global-skills-all-runtimes",
        purpose: "planning-with-files-global-skill",
        kind: "dir",
        directoryClosureSha256: closure.sha256,
        directoryClosureEntryCount: closure.entryCount,
      });
    }

    const manifestPath = path.join(root, ".meta-kim", "install-manifest.json");
    writeManifest(manifestPath, manifest);
    const codexHooks = path.join(homes.codex, "hooks");
    mkdirSync(path.join(codexHooks, "__pycache__"), { recursive: true });
    const ownedFiles = {
      "codex_hook_adapter.py": "[planning-with-files]\ndef run_shell_script(): pass\nHOOK_DIR = 1\n",
      "codex_hook_runner.mjs": "collectWindowsPythonCandidatePaths\nINSTALL_TIME_PYTHON_HINT\nconst scriptPath = process.argv[2]\n",
      "session_start.py": 'import codex_hook_adapter as adapter\nadapter.run_shell_script("session-start.sh", root)\n',
      "user_prompt_submit.py": 'import codex_hook_adapter as adapter\nadapter.run_shell_script("user-prompt-submit.sh", root)\n',
      "pre_tool_use.py": 'import codex_hook_adapter as adapter\nadapter.run_shell_script("pre-tool-use.sh", root)\n',
      "post_tool_use.py": 'import codex_hook_adapter as adapter\nadapter.run_shell_script("post-tool-use.sh", root)\n',
      "stop.py": 'import codex_hook_adapter as adapter\nadapter.run_shell_script("stop.sh", root)\n',
    };
    for (const [name, content] of Object.entries(ownedFiles)) {
      writeFileSync(path.join(codexHooks, name), content, "utf8");
    }
    writeFileSync(
      path.join(codexHooks, "__pycache__", "codex_hook_adapter.cpython-312.pyc"),
      "fixture",
      "utf8",
    );
    writeFileSync(path.join(codexHooks, "user-owned.py"), "# keep\n", "utf8");
    writeFileSync(
      path.join(homes.codex, "hooks.json"),
      `${JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [
            {
              type: "command",
              command: `node ${path.join(codexHooks, "codex_hook_runner.mjs")} ${path.join(codexHooks, "user_prompt_submit.py")}`,
            },
            { type: "command", command: "node C:/user/hook.mjs" },
          ] }],
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const result = spawnSync(process.execPath, [retirementScript], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        META_KIM_CLAUDE_HOME: homes.claude,
        META_KIM_CODEX_HOME: homes.codex,
        META_KIM_CURSOR_HOME: homes.cursor,
        META_KIM_OPENCLAW_HOME: homes.openclaw,
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);

    for (const runtimeHome of Object.values(homes)) {
      assert.throws(() => readFileSync(path.join(runtimeHome, "skills", "planning-with-files", "SKILL.md")));
      assert.throws(() => readFileSync(path.join(runtimeHome, "plugins", "planning-with-files", "SKILL.md")));
    }
    const hooks = JSON.parse(readFileSync(path.join(homes.codex, "hooks.json"), "utf8"));
    assert.equal(hooks.hooks.UserPromptSubmit[0].hooks.length, 1);
    assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].command, "node C:/user/hook.mjs");
    assert.equal(readFileSync(path.join(codexHooks, "user-owned.py"), "utf8"), "# keep\n");
    const updatedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(updatedManifest.entries.some((entry) => entry.purpose === "planning-with-files-global-skill"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
