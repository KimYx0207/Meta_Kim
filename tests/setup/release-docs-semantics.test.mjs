import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("release documentation semantics", () => {
  const readmeFiles = [
    "README.md",
    "README.zh-CN.md",
    "README.ja-JP.md",
    "README.ko-KR.md",
  ];

  const currentChangelogSection = (raw) => {
    const nextReleaseIndex = raw.search(/\n## \[[^\]]+\] - \d{4}-\d{2}-\d{2}/);
    return nextReleaseIndex === -1 ? raw : raw.slice(0, nextReleaseIndex);
  };

  test("generated runtime projections stay outside GitHub source and package files", () => {
    const output = execFileSync(
      process.execPath,
      ["scripts/validate-open-source-boundary.mjs"],
      { cwd: root, encoding: "utf8" },
    );
    assert.match(output, /open-source boundary valid/);

    const packageJson = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    );
    const forbiddenSources = [
      ".claude/",
      ".codex/",
      ".agents/",
      ".cursor/",
      "openclaw/",
      "codex/",
      ".mcp.json",
    ];

    for (const forbiddenSource of forbiddenSources) {
      assert.ok(
        !packageJson.files.some(
          (entry) =>
            entry === forbiddenSource || entry.startsWith(forbiddenSource),
        ),
        `package.json files must not include ${forbiddenSource}`,
      );
    }
  });

  test("npm dry-run package manifest preserves the design PoC boundary", () => {
    const npmCli = process.env.npm_execpath || path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    assert.equal(existsSync(npmCli), true, `npm CLI not found: ${npmCli}`);

    const cacheDir = mkdtempSync(path.join(tmpdir(), "meta-kim-npm-pack-cache-"));
    try {
      const raw = execFileSync(
        process.execPath,
        [npmCli, "pack", "--dry-run", "--ignore-scripts", "--offline", "--json"],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, npm_config_cache: cacheDir },
        },
      );
      const manifest = JSON.parse(raw);
      const packageFiles = new Set(manifest[0]?.files?.map((entry) => entry.path) ?? []);
      for (const requiredFile of [
        "canonical/runtime-assets/shared/lib/deliverable-type-profile.mjs",
        "canonical/runtime-assets/shared/lib/gate-dispatcher.mjs",
        "canonical/runtime-assets/shared/lib/intent-verb-lexicon.mjs",
        "canonical/runtime-assets/shared/lib/policy-registry.mjs",
        "config/contracts/deliverable-type-profiles.json",
        "CHANGELOG.md",
        "CHANGELOG.zh-CN.md",
      ]) {
        assert.equal(packageFiles.has(requiredFile), true, `package missing ${requiredFile}`);
      }
      for (const retiredFile of [
        "canonical/runtime-assets/shared/lib/validator.mjs",
        "tests/poc-design-gate/RESULTS.md",
      ]) {
        assert.equal(packageFiles.has(retiredFile), false, `package retained ${retiredFile}`);
      }
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("clone users are told to pull source updates before running setup --update", () => {
    for (const file of readmeFiles) {
      const raw = readFileSync(path.join(root, file), "utf8");

      assert.match(raw, /git pull --ff-only/);
      assert.match(raw, /setup\.mjs --update/);
      assert.doesNotMatch(
        raw,
        /\| `node setup\.mjs --update` \| (?:Update all skills and dependencies|更新所有技能和依赖|すべての skill と依存関係を更新|모든 스킬과 의존성 업데이트) \|/,
      );
    }
  });

  test("runtime coverage guidance uses current Codex and Cursor skill paths", () => {
    const agents = readFileSync(path.join(root, "AGENTS.md"), "utf8");
    const syncConfig = readFileSync(
      path.join(root, "config", "sync.json"),
      "utf8",
    );
    const raw = `${agents}\n${syncConfig}`;

    assert.match(raw, /`\.agents\/skills\/`/);
    assert.match(raw, /`\.codex\/skills\/`/);
    assert.match(raw, /`\.cursor\/skills\/meta-theory\/`|"\.cursor\/skills"/);
    assert.match(raw, /`\.agents\/skills\/meta-theory\/SKILL\.md`/);
    assert.doesNotMatch(raw, /docs\/runtime-coverage-audit\.md/);
  });

  test("public current docs do not repeat dependency project install target matrices as Meta_Kim support claims", () => {
    const forbiddenDependencyMatrixPatterns = [
      /Native dependency install targets/,
      /原生依赖安装目标/,
      /ネイティブ依存インストール対象/,
      /네이티브 의존성 설치 대상/,
      /opencode,\s*Qwen,\s*Zed,\s*Gemini,\s*CodeBuddy,\s*Antigravity,\s*JoyCode/,
      /opencode、Qwen、Zed、Gemini、CodeBuddy、Antigravity、JoyCode/,
      /ECC additionally supports native install targets/,
      /ECC 另外原生支持/,
      /ECC はさらに .*native install target/,
      /ECC는 추가로 .*native install target/,
    ];

    for (const file of readmeFiles) {
      const raw = readFileSync(path.join(root, file), "utf8");

      for (const pattern of forbiddenDependencyMatrixPatterns) {
        assert.doesNotMatch(raw, pattern, `${file} repeats dependency target matrix`);
      }
    }

    for (const file of ["CHANGELOG.md", "CHANGELOG.zh-CN.md"]) {
      const raw = currentChangelogSection(
        readFileSync(path.join(root, file), "utf8"),
      );

      for (const pattern of forbiddenDependencyMatrixPatterns) {
        assert.doesNotMatch(raw, pattern, `${file} Unreleased repeats dependency target matrix`);
      }
    }

    assert.match(
      readFileSync(path.join(root, "README.md"), "utf8"),
      /Dependency-project install targets are handled by those upstream projects/,
    );
    assert.match(
      readFileSync(path.join(root, "README.zh-CN.md"), "utf8"),
      /依赖项目自己的安装目标由上游项目维护/,
    );
    assert.match(
      readFileSync(path.join(root, "README.ja-JP.md"), "utf8"),
      /依存プロジェクト側の install target は upstream project で管理される/,
    );
    assert.match(
      readFileSync(path.join(root, "README.ko-KR.md"), "utf8"),
      /의존 프로젝트의 install target은 upstream project에서 관리/,
    );
  });

  test("public current docs expose formal projections and candidate compatibility probes without overpromoting them", () => {
    const candidateNames = [
      "Qoder",
      "Trae",
      "Kiro",
      "Cline",
      "Roo",
      "Continue",
    ];
    const overbroadMappingPatterns = [
      /any project that supports agents and agent-to-agent communication/,
      /任何支持 agent 且支持 agent-to-agent 通信/,
      /任意のプロジェクトに映射できます/,
      /모든 프로젝트에 매핑할 수 있습니다/,
    ];
    const staleFullSupportRows = [
      /\*\*OpenClaw\*\*\s*\|\s*完全対応/,
      /\*\*Cursor\*\*\s*\|\s*完全対応/,
      /\*\*OpenClaw\*\*\s*\|\s*완전 지원/,
      /\*\*Cursor\*\*\s*\|\s*완전 지원/,
    ];

    for (const file of readmeFiles) {
      const raw = readFileSync(path.join(root, file), "utf8");

      assert.match(raw, /alt="Projection tiers"/, file);
      assert.match(raw, /alt="Candidate compatibility probes"/, file);
      assert.match(
        raw,
        /default-Claude%20Code%20%7C%20Codex%20%2B%20compat-OpenClaw%20%7C%20Cursor/,
        file,
      );
      assert.match(raw, /Qoder%20%7C%20Trae%20%7C%20Kiro%20%7C%20Cascade%20%7C%20Cline%20%7C%20Roo%20%7C%20Continue/, file);
      assert.doesNotMatch(raw, /alt="Runtime"/, file);
      assert.doesNotMatch(raw, /runtime-Claude%20Code%20%7C%20Codex%20%7C%20OpenClaw%20%7C%20Cursor/, file);

      for (const candidateName of candidateNames) {
        assert.match(raw, new RegExp(candidateName), `${file} missing ${candidateName}`);
      }
      for (const pattern of overbroadMappingPatterns) {
        assert.doesNotMatch(raw, pattern, `${file} has overbroad mapping claim`);
      }
      for (const pattern of staleFullSupportRows) {
        assert.doesNotMatch(raw, pattern, `${file} overpromotes compatibility projection`);
      }
    }

    assert.match(readFileSync(path.join(root, "README.md"), "utf8"), /Default formal projections/);
    assert.match(readFileSync(path.join(root, "README.md"), "utf8"), /Non-default compatibility projections/);
    assert.match(readFileSync(path.join(root, "README.md"), "utf8"), /Candidate compatibility probes/);
    assert.match(readFileSync(path.join(root, "README.zh-CN.md"), "utf8"), /默认正式投影/);
    assert.match(readFileSync(path.join(root, "README.zh-CN.md"), "utf8"), /非默认兼容投影/);
    assert.match(readFileSync(path.join(root, "README.zh-CN.md"), "utf8"), /候选兼容 probe/);
  });

  test("change readiness checklist covers P1 and P2 release review lanes", () => {
    const checklist = readFileSync(
      path.join(root, "config", "contracts", "change-readiness-checklist.md"),
      "utf8",
    );
    const pullRequestTemplate = readFileSync(
      path.join(root, ".github", "pull_request_template.md"),
      "utf8",
    );
    const combined = `${checklist}\n${pullRequestTemplate}`;

    assert.match(combined, /Host State Impact Matrix/);
    assert.match(combined, /Installed-User Compatibility Gate/);
    assert.match(combined, /Historical-version update/);
    assert.match(combined, /Partial or failed prior install/);
    assert.match(combined, /fresh install is not enough/);
    assert.match(combined, /Existing host state/);
    assert.match(combined, /Rollback path/);
    assert.match(combined, /Hook \/ Prompt Protocol Flow/);
    assert.match(combined, /Model-visible field/);
    assert.match(combined, /Deletion \/ Refactor Residue Sweep/);
    assert.match(combined, /Evidence Budget/);
    assert.match(combined, /operationSteps/);
    assert.match(combined, /hostVisibleResult/);
    assert.match(combined, /reviewStatus/);
    assert.match(combined, /Install \/ Update Status Semantics/);
    assert.match(combined, /success/);
    assert.match(combined, /skipped/);
    assert.match(combined, /manual/);
    assert.match(combined, /failed/);
    assert.match(combined, /Host-side or installed-user self-test/);
    assert.match(combined, /Execution Mode Classification/);
    assert.match(combined, /real_execution/);
    assert.match(combined, /read_only_sidecar/);
    assert.match(combined, /approval_gate/);
  });

  test("workflow execution modes are mapped into semantic execution classes", () => {
    const contract = JSON.parse(
      readFileSync(
        path.join(root, "config", "contracts", "workflow-contract.json"),
        "utf8",
      ),
    );
    const policy =
      contract.protocols.workerTaskPacket.executionModePolicy;

    assert.deepEqual(policy.executionModeClasses, [
      "real_execution",
      "read_only_sidecar",
      "approval_gate",
    ]);
    for (const mode of policy.executionWorkerModes) {
      assert.equal(policy.executionModeClassMap[mode], "real_execution");
    }
    for (const mode of policy.sidecarModes) {
      assert.equal(policy.executionModeClassMap[mode], "read_only_sidecar");
    }
    for (const mode of policy.approvalGateModes) {
      assert.equal(policy.executionModeClassMap[mode], "approval_gate");
    }
    assert.deepEqual(
      Object.keys(policy.executionModeClassMap).sort(),
      [...policy.executionModeEnum].sort(),
    );
  });

  test("project license documents Apache-2.0 commercial use and NOTICE attribution", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    );
    const notice = readFileSync(path.join(root, "NOTICE"), "utf8");

    assert.equal(packageJson.license, "Apache-2.0");
    assert.ok(packageJson.files.includes("NOTICE"));
    assert.match(notice, /Meta_Kim by KimYx0207/);
    assert.match(notice, /Commercial use is permitted under the Apache License, Version 2\.0/);

    for (const file of readmeFiles) {
      const raw = readFileSync(path.join(root, file), "utf8");

      assert.match(raw, /license-Apache--2\.0/);
      assert.match(raw, /Apache License 2\.0/);
      assert.match(raw, /NOTICE/);
      assert.match(raw, /Meta_Kim by KimYx0207/);
      assert.doesNotMatch(raw, /Meta_Kim (?:is|itself is) MIT licensed/);
      assert.doesNotMatch(raw, /Meta_Kim 本身采用 MIT/);
      assert.doesNotMatch(raw, /Meta_Kim 自体は MIT/);
      assert.doesNotMatch(raw, /Meta_Kim 자체는 MIT/);
    }
  });
});
