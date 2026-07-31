import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildGlobalCapabilityInventory,
  checkCanonicalCapabilityIndex,
  deriveCapabilityIndexMirrorTargets,
  formatTableOutput,
  mergeCanonicalHookSources,
  preserveGeneratedAtWhenUnchanged,
  updateGlobalCapabilityInventory,
  writeCanonicalCapabilityIndex,
} from "../../scripts/discover-global-capabilities.mjs";
import {
  loadSyncManifest,
  repoRoot,
  resolveRuntimeProjection,
} from "../../scripts/meta-kim-sync-config.mjs";

const canonicalIndexPath = path.join(
  repoRoot,
  "config",
  "capability-index",
  "meta-kim-capabilities.json",
);

function platformScan(platformId, agentIds) {
  return {
    platformId,
    capabilities: {
      agents: agentIds.map((id) => ({ id, platformId })),
      skills: [],
      hooks: [],
      mcpServers: [],
      mcpTools: [],
      plugins: [],
      commands: [],
      rules: [],
      prompts: [],
    },
    errors: [],
  };
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(repoRoot, relativePath), "utf8"));
}

async function readProjectProjectionMode() {
  try {
    const overrides = await readJson(".meta-kim/local.overrides.json");
    return typeof overrides.projectProjectionMode === "string"
      ? overrides.projectProjectionMode
      : "project";
  } catch {
    return "project";
  }
}

async function listCanonicalSkillIds() {
  const skillsRoot = path.join(repoRoot, "canonical", "skills");
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await fs.access(path.join(skillsRoot, entry.name, "SKILL.md"));
      ids.push(entry.name);
    } catch {}
  }
  return ids.sort();
}

describe("capability index inheritance chain", () => {
  test("same-name Claude Hook adapter cannot overwrite shared canonical source", () => {
    const shared = [
      {
        id: "spine-state.mjs",
        path: "/repo/canonical/runtime-assets/shared/hooks/spine-state.mjs",
      },
    ];
    const claude = [
      {
        id: "spine-state.mjs",
        path: "/repo/canonical/runtime-assets/claude/hooks/spine-state.mjs",
      },
      {
        id: "claude-only.mjs",
        path: "/repo/canonical/runtime-assets/claude/hooks/claude-only.mjs",
      },
    ];

    assert.deepEqual(
      mergeCanonicalHookSources(shared, claude, [], {
        verifiedThinAdapterIds: new Set(["spine-state.mjs"]),
      }),
      [
        {
          ...shared[0],
          adapterPath: claude[0].path,
        },
        claude[1],
      ],
    );
  });

  test("unverified Claude and same-name OpenClaw Hooks cannot overwrite shared truth", () => {
    const shared = [{ id: "same.mjs", path: "/shared/same.mjs" }];
    const claude = [{ id: "same.mjs", path: "/claude/same.mjs" }];
    const openclaw = [{ id: "same.mjs", path: "/openclaw/same.mjs" }];
    const merged = mergeCanonicalHookSources(shared, claude, openclaw);

    assert.deepEqual(merged, [
      shared[0],
      { ...claude[0], namespace: "canonical-claude-hooks" },
      { ...openclaw[0], namespace: "canonical-openclaw-hooks" },
    ]);
  });

  test("global discovery table defaults to category stats instead of dumping every capability", () => {
    const index = {
      byPlatform: {
        codex: {
          platform: "Codex",
          platformId: "codex",
          baseDir: "/home/user/.codex",
          capabilities: {
            agents: [],
            skills: [
              {
                id: "gstack/autoplan",
                platformId: "codex",
              },
              {
                id: "gstack/browse",
                platformId: "codex",
              },
            ],
            hooks: [
              {
                id: "meta-kim/graphify-context.mjs",
                relativePath: "meta-kim/graphify-context.mjs",
                platformId: "codex",
              },
              {
                id: "graphify-context.mjs",
                relativePath: "graphify-context.mjs",
                platformId: "codex",
              },
              {
                id: "hooks-json",
                relativePath: "hooks.json",
                platformId: "codex",
                metadata: { providerKind: "hook-config" },
              },
            ],
            plugins: [],
            commands: [],
            rules: [],
            prompts: [],
            mcpServers: [],
            mcpTools: [],
          },
          errors: [],
        },
      },
      byCapabilityType: {
        agents: {},
        skills: {
          "codex:gstack/autoplan": {
            id: "gstack/autoplan",
            platformId: "codex",
          },
          "codex:gstack/browse": {
            id: "gstack/browse",
            platformId: "codex",
          },
        },
        hooks: {
          "codex:meta-kim/graphify-context.mjs": {
            id: "meta-kim/graphify-context.mjs",
            relativePath: "meta-kim/graphify-context.mjs",
            platformId: "codex",
          },
          "codex:graphify-context.mjs": {
            id: "graphify-context.mjs",
            relativePath: "graphify-context.mjs",
            platformId: "codex",
          },
          "codex:hooks-json": {
            id: "hooks-json",
            relativePath: "hooks.json",
            platformId: "codex",
            metadata: { providerKind: "hook-config" },
          },
        },
        plugins: {},
        commands: {},
        rules: {},
        prompts: {},
        mcpServers: {},
        mcpTools: {},
      },
    };

    const summary = formatTableOutput(index);
    assert.match(summary, /Hooks by category/);
    assert.match(summary, /Meta_Kim namespaced 1/);
    assert.match(summary, /Meta_Kim legacy root 1/);
    assert.match(summary, /runtime config 1/);
    assert.match(summary, /Skills by family/);
    assert.match(summary, /gstack 2/);
    assert.doesNotMatch(summary, /codex:gstack\/autoplan/);
    assert.doesNotMatch(summary, /### HOOKS/);
    assert.doesNotMatch(summary, /codex:hooks-json|codex:graphify-context\.mjs/);

    const details = formatTableOutput(index, { verbose: true });
    assert.match(details, /codex:gstack\/autoplan/);
    assert.match(details, /codex:hooks-json/);

    const zhSummary = formatTableOutput(index, { lang: "zh-CN" });
    assert.match(zhSummary, /按平台统计/);
    assert.match(zhSummary, /Hooks 分类统计/);
    assert.match(zhSummary, /Skills 家族统计/);
    assert.match(zhSummary, /默认只显示分类统计/);
    assert.doesNotMatch(zhSummary, /By platform|Details hidden by default/);
  });

  test("global discovery supports selected runtime target filters", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts", "discover-global-capabilities.mjs"),
      "utf8",
    );

    assert.match(source, /const TARGET_ALIASES = \{/);
    assert.match(source, /claude: "claudeCode"/);
    assert.match(source, /function normalizePlatformTargets\(rawValue\)/);
    assert.match(source, /argValue\(args, "--targets"\) \|\| argValue\(args, "--platform"\)/);
    assert.match(source, /filterTargets\.length > 0/);
    assert.match(source, /runtimeInventoryOnly/);
    assert.match(source, /writeRepoIndex = !runtimeInventoryOnly/);
    assert.match(source, /HOME_GLOBAL_INVENTORY/);
    assert.match(source, /\.meta-kim-legacy-backup\//);
    assert.doesNotMatch(
      source,
      /const platformsToScan = filterPlatform/,
      "global discovery must not use the old single-platform-only filter path",
    );
  });

  test("targeted global discovery refresh preserves unselected runtime inventories", async () => {
    const initial = await buildGlobalCapabilityInventory(
      [platformScan("claudeCode", ["claude-worker"])],
      "default",
    );
    const withCodex = await buildGlobalCapabilityInventory(
      [platformScan("codexApp", ["codex-worker"])],
      "default",
      initial,
    );

    assert.deepEqual(Object.keys(withCodex.byPlatform).sort(), ["claudeCode", "codexApp"]);
    assert.ok(withCodex.byCapabilityType.agents["claudeCode:claude-worker"]);
    assert.ok(withCodex.byCapabilityType.agents["codexApp:codex-worker"]);

    const refreshedClaude = await buildGlobalCapabilityInventory(
      [platformScan("claudeCode", ["claude-worker-v2"])],
      "default",
      withCodex,
    );
    assert.equal(refreshedClaude.byCapabilityType.agents["claudeCode:claude-worker"], undefined);
    assert.ok(refreshedClaude.byCapabilityType.agents["claudeCode:claude-worker-v2"]);
    assert.ok(refreshedClaude.byCapabilityType.agents["codexApp:codex-worker"]);
  });

  test("source-aware inventory selects a stable skill winner and preserves every source", async () => {
    const sourceCandidates = [
      {
        id: "same-skill",
        platformId: "codex",
        path: "/project/.agents/skills/same-skill/SKILL.md",
        sourceClass: "project",
        sourceRoot: "/project/.agents/skills",
        sourceRef: ".agents/skills/same-skill/SKILL.md",
        contentDigest: "1".repeat(64),
      },
      {
        id: "same-skill",
        platformId: "codex",
        path: "/home/user/.codex/skills/same-skill/SKILL.md",
        sourceClass: "personal",
        sourceRoot: "/home/user/.codex/skills",
        sourceRef: "~/.codex/skills/same-skill/SKILL.md",
        contentDigest: "2".repeat(64),
      },
      {
        id: "same-skill",
        platformId: "codex",
        path: "/home/user/.agents/skills/same-skill/SKILL.md",
        sourceClass: "shared",
        sourceRoot: "/home/user/.agents/skills",
        sourceRef: "~/.agents/skills/same-skill/SKILL.md",
        contentDigest: "3".repeat(64),
      },
      {
        id: "same-skill",
        platformId: "codex",
        path: "/home/user/legacy/same-skill/SKILL.md",
        sourceClass: "legacy",
        sourceRoot: "/home/user/legacy",
        sourceRef: "legacy/same-skill/SKILL.md",
        contentDigest: "4".repeat(64),
      },
    ];
    const scan = {
      platformId: "codex",
      capabilities: {
        agents: [],
        skills: sourceCandidates,
        hooks: [],
        mcpServers: [],
        mcpTools: [],
        plugins: [],
        commands: [],
        rules: [],
        prompts: [],
      },
      errors: [],
    };

    const forward = await buildGlobalCapabilityInventory([scan], "source-aware");
    const reverse = await buildGlobalCapabilityInventory(
      [{ ...scan, capabilities: { ...scan.capabilities, skills: [...sourceCandidates].reverse() } }],
      "source-aware",
    );
    const winner = forward.byCapabilityType.skills["codex:same-skill"];
    const reverseWinner = reverse.byCapabilityType.skills["codex:same-skill"];

    assert.equal(winner.sourceClass, "project");
    assert.equal(winner.sourcePriority, 400);
    assert.equal(winner.nativeIdentity, "same-skill");
    assert.equal(winner.contentDigest, "1".repeat(64));
    assert.equal(winner.sourceKey, reverseWinner.sourceKey);
    assert.equal(winner.collision.kind, "conflicting_definitions");
    assert.equal(winner.collision.routeEligible, true);
    assert.equal(winner.provenance.length, 4);
    assert.deepEqual(
      winner.provenance.map((entry) => entry.sourceClass),
      ["project", "personal", "shared", "legacy"],
    );
    assert.equal(forward.byPlatform.codex.capabilities.skills.length, 4);
    assert.ok(
      forward.byPlatform.codex.capabilities.skills.every(
        (entry) => entry.provenance.length === 4 && entry.collision.candidateCount === 4,
      ),
      "raw platform evidence must retain the full collision provenance",
    );
  });

  test("published global inventory omits raw absolute paths and workspace metadata", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "meta-kim-private-inventory-"),
    );
    const skillPath = path.join(tempRoot, "skills", "private-skill", "SKILL.md");
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, "# Private skill\n", "utf8");
    try {
      const inventory = await buildGlobalCapabilityInventory(
        [{
          platform: "Codex",
          platformId: "codex",
          baseDir: tempRoot,
          capabilities: {
            agents: [],
            skills: [{
              id: "private-skill",
              type: "skills",
              platform: "Codex",
              platformId: "codex",
              path: skillPath,
              relativePath: path.join("private-skill", "SKILL.md"),
              metadata: {
                name: "private-skill",
                description: `Loaded from ${skillPath} and \\\\private-server\\private-share\\secret`,
                workspace: tempRoot,
              },
            }],
            hooks: [],
            mcpServers: [{
              id: "private-mcp",
              type: "mcpServers",
              platform: "Codex",
              platformId: "codex",
              relativePath: "../private-mcp.json",
              command: "node",
              args: [
                "server.mjs",
                "--token",
                "private-token-value",
                "--api-key=private-key-value",
                "--header",
                "Authorization: Bearer private-bearer-value",
                "--client-secret",
                "private-client-secret",
                "--access-token=private-access-token",
                "AWS_SECRET_ACCESS_KEY=private-aws-secret",
                "https://user:pass@example.test/mcp?access_token=private-query-value&safe=visible",
              ],
              metadata: {
                name: "private-mcp",
                providerKind: "mcp-server",
                args: "server.mjs --header=X-Api-Key: private-inline-header --http-header Cookie: private-cookie --safe visible",
              },
            }],
            mcpTools: [],
            plugins: [],
            commands: [],
            rules: [],
            prompts: [],
          },
          errors: [`Platform directory not found: ${tempRoot}`],
        }],
        "privacy-test",
      );
      const serialized = JSON.stringify(inventory);
      const skill = inventory.byCapabilityType.skills["codex:private-skill"];
      const mcp = inventory.byCapabilityType.mcpServers["codex:private-mcp"];

      assert.equal("path" in skill, false);
      assert.equal("workspace" in (skill.metadata ?? {}), false);
      assert.equal("baseDir" in inventory.byPlatform.codex, false);
      assert.equal(serialized.includes(tempRoot), false);
      assert.equal(serialized.includes(tempRoot.replace(/\\/gu, "/")), false);
      assert.equal(serialized.includes(repoRoot), false);
      assert.equal(serialized.includes(repoRoot.replace(/\\/gu, "/")), false);
      assert.equal(serialized.includes("private-server"), false);
      assert.equal(serialized.includes("private-share"), false);
      assert.match(skill.sourceRef, /^(?:~\/|external\/)/u);
      assert.match(skill.contentDigest, /^[a-f0-9]{64}$/u);
      assert.deepEqual(mcp.args.slice(0, 6), [
        "server.mjs",
        "--token",
        "[REDACTED_ARGUMENT]",
        "--api-key=[REDACTED_ARGUMENT]",
        "--header",
        "[REDACTED_ARGUMENT]",
      ]);
      assert.deepEqual(mcp.args.slice(6, 10), [
        "--client-secret",
        "[REDACTED_ARGUMENT]",
        "--access-token=[REDACTED_ARGUMENT]",
        "AWS_SECRET_ACCESS_KEY=[REDACTED_ARGUMENT]",
      ]);
      const urlArg = mcp.args.at(-1);
      assert.equal(urlArg.includes("user:pass"), false);
      assert.equal(urlArg.includes("private-query-value"), false);
      assert.match(urlArg, /REDACTED/);
      assert.equal("relativePath" in mcp, false);
      assert.equal(JSON.stringify(mcp.metadata).includes("private-token-value"), false);
      assert.equal(JSON.stringify(mcp.metadata).includes("private-key-value"), false);
      assert.equal(JSON.stringify(mcp.metadata).includes("private-inline-header"), false);
      assert.equal(JSON.stringify(mcp.metadata).includes("private-cookie"), false);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("concurrent targeted refreshes publish complete JSON without losing another runtime", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "meta-kim-capability-inventory-race-"),
    );
    const inventoryPath = path.join(tempRoot, "global-capabilities.json");
    try {
      await Promise.all([
        updateGlobalCapabilityInventory({
          scannedResults: [platformScan("claudeCode", ["claude-worker"])],
          profile: "concurrency-test",
          localInventoryPath: inventoryPath,
        }),
        updateGlobalCapabilityInventory({
          scannedResults: [platformScan("codexApp", ["codex-worker"])],
          profile: "concurrency-test",
          localInventoryPath: inventoryPath,
        }),
      ]);

      const inventory = JSON.parse(await fs.readFile(inventoryPath, "utf8"));
      assert.deepEqual(Object.keys(inventory.byPlatform).sort(), ["claudeCode", "codexApp"]);
      assert.ok(inventory.byCapabilityType.agents["claudeCode:claude-worker"]);
      assert.ok(inventory.byCapabilityType.agents["codexApp:codex-worker"]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("repo MCP discovery uses canonical runtime asset instead of project projection", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts", "discover-global-capabilities.mjs"),
      "utf8",
    );

    assert.match(
      source,
      /canonical",\s*"runtime-assets",\s*"claude",\s*"mcp\.json"/,
      "repo capability discovery must read the canonical MCP template",
    );
    assert.match(
      source,
      /resolveRepoPlaceholdersInArgs\(args\)/,
      "canonical MCP __REPO_ROOT__ placeholders must be resolved for self-test",
    );
    assert.doesNotMatch(
      source,
      /scanMcpConfig\(path\.join\(repoRoot,\s*"\.mcp\.json"\)\)/,
      "repo capability discovery must not require a project .mcp.json projection",
    );
  });

  test("runtime mirror capability indexes are optional in clean checkout but exact when project projections are active", async () => {
    if ((await readProjectProjectionMode()) === "global_only") {
      return;
    }

    const index = await readJson("config/capability-index/meta-kim-capabilities.json");
    const mirrorIndexPaths = (index.mirroredTo ?? []).map((relativePath) =>
      path.join(repoRoot, relativePath),
    );
    const canonical = await fs.readFile(canonicalIndexPath, "utf8");
    for (const mirrorPath of mirrorIndexPaths) {
      try {
        await fs.access(mirrorPath);
      } catch {
        continue;
      }
      assert.equal(
        await fs.readFile(mirrorPath, "utf8"),
        canonical,
        `${path.relative(repoRoot, mirrorPath).replace(/\\/g, "/")} must exactly mirror the canonical capability index`,
      );
    }
  });

  test("capability mirror metadata is derived from the sync manifest runtime layouts", async () => {
    const manifest = await loadSyncManifest();
    const actual = await deriveCapabilityIndexMirrorTargets({ manifest });
    const fileName = path.basename(canonicalIndexPath);
    const expected = manifest.supportedTargets.map((runtimeId) => {
      const projection = resolveRuntimeProjection(runtimeId, "project");
      return path
        .relative(
          repoRoot,
          path.join(projection.capabilityIndexDir, fileName),
        )
        .replace(/\\/g, "/");
    });

    assert.deepEqual(actual, expected);
    assert.equal(new Set(actual).size, actual.length);
  });

  test("discovery canonical writes never create, rewrite, or delete runtime mirrors", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "meta-kim-capability-discovery-"),
    );
    try {
      const manifest = await loadSyncManifest();
      const mirroredTo = await deriveCapabilityIndexMirrorTargets({
        projectRoot: tempRoot,
        manifest,
      });
      const canonicalPath = path.join(
        tempRoot,
        "config",
        "capability-index",
        path.basename(canonicalIndexPath),
      );
      const sentinelMirrors = mirroredTo.filter((_, index) => index % 2 === 0);
      const absentMirrors = mirroredTo.filter((_, index) => index % 2 === 1);

      for (const relativePath of sentinelMirrors) {
        const mirrorPath = path.join(tempRoot, relativePath);
        await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
        await fs.writeFile(mirrorPath, `user-owned:${relativePath}\n`, "utf8");
      }

      const index = {
        registryName: "test-capability-index",
        mirroredTo,
        byCapabilityType: {},
      };
      await writeCanonicalCapabilityIndex(canonicalPath, index);

      assert.deepEqual(
        JSON.parse(await fs.readFile(canonicalPath, "utf8")),
        index,
      );
      for (const relativePath of sentinelMirrors) {
        assert.equal(
          await fs.readFile(path.join(tempRoot, relativePath), "utf8"),
          `user-owned:${relativePath}\n`,
        );
      }
      for (const relativePath of absentMirrors) {
        await assert.rejects(
          fs.access(path.join(tempRoot, relativePath)),
          (error) => error?.code === "ENOENT",
        );
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("canonical discovery check is read-only and detects stale content", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "meta-kim-capability-check-"),
    );
    try {
      const canonicalPath = path.join(tempRoot, "meta-kim-capabilities.json");
      const current = {
        generatedAt: "2026-07-14T00:00:00.000Z",
        registryName: "test-capability-index",
        mirroredTo: [],
      };
      await writeCanonicalCapabilityIndex(canonicalPath, current);

      const matching = await checkCanonicalCapabilityIndex(canonicalPath, current);
      assert.equal(matching.ok, true);

      const staleExpected = { ...current, registryName: "changed-capability-index" };
      const before = await fs.readFile(canonicalPath, "utf8");
      const stale = await checkCanonicalCapabilityIndex(canonicalPath, staleExpected);
      const after = await fs.readFile(canonicalPath, "utf8");
      assert.equal(stale.ok, false);
      assert.equal(after, before, "--check semantics must not rewrite canonical source");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("global discovery leaves runtime mirror convergence to sync", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts", "discover-global-capabilities.mjs"),
      "utf8",
    );

    assert.match(source, /Project mirrors are generated by sync-runtimes\.mjs/);
    assert.doesNotMatch(source, /platformIndexDirs/);
    assert.doesNotMatch(source, /canonicalIndexMirrored\(/);
  });

  test("capability index covers every canonical agent and root skill", async () => {
    const index = await readJson("config/capability-index/meta-kim-capabilities.json");
    const indexedAgentPaths = new Set(
      Object.values(index.byCapabilityType?.agents ?? {}).map((entry) => entry.path),
    );
    const indexedSkillPaths = new Set(
      Object.values(index.byCapabilityType?.skills ?? {}).map((entry) => entry.path),
    );

    const agentFiles = (await fs.readdir(path.join(repoRoot, "canonical", "agents")))
      .filter((file) => file.endsWith(".md"))
      .map((file) => `canonical/agents/${file}`)
      .sort();
    const skillPaths = (await listCanonicalSkillIds()).map(
      (id) => `canonical/skills/${id}/SKILL.md`,
    );

    assert.deepEqual(
      agentFiles.filter((agentPath) => !indexedAgentPaths.has(agentPath)),
      [],
      "every canonical agent file must be represented in byCapabilityType.agents",
    );
    assert.deepEqual(
      skillPaths.filter((skillPath) => !indexedSkillPaths.has(skillPath)),
      [],
      "every canonical skill SKILL.md must be represented in byCapabilityType.skills",
    );
  });

  test("capability index covers canonical runtime commands", async () => {
    const index = await readJson("config/capability-index/meta-kim-capabilities.json");
    const commandPaths = new Set(
      Object.values(index.byCapabilityType?.commands ?? {}).map((entry) => entry.path),
    );

    for (const expectedPath of [
      "canonical/runtime-assets/claude/commands/save-progress/SKILL.md",
      "canonical/runtime-assets/codex/commands/meta-theory.md",
    ]) {
      assert.ok(
        commandPaths.has(expectedPath),
        `${expectedPath} must be represented in byCapabilityType.commands`,
      );
    }
    assert.ok(
      index.summary?.totalCommands >= 2,
      "capability index summary must count canonical runtime commands",
    );
  });

  test("capability index separates canonical totals from runtime actual counts", async () => {
    const index = await readJson("config/capability-index/meta-kim-capabilities.json");
    assert.equal(
      index.summary?.countSemantics?.totalHooks,
      "canonical_inventory_entries",
    );
    assert.equal(
      index.summary?.countSemantics?.totalCommands,
      "canonical_inventory_entries",
    );
    assert.equal(
      index.summary?.runtimeActualCounts?.scope,
      "local_project_projection_when_present",
    );
    assert.equal(
      index.summary?.runtimeActualCounts?.canonicalInventory?.hooks,
      index.summary?.totalHooks,
    );
    assert.equal(
      index.summary?.runtimeActualCounts?.canonicalInventory?.commands,
      index.summary?.totalCommands,
    );
    for (const runtime of ["claude", "codex", "cursor", "openclaw"]) {
      const counts = index.summary?.runtimeActualCounts?.[runtime];
      assert.equal(typeof counts?.projectionPresent, "boolean", runtime);
      assert.equal(typeof counts?.hookCommandEntries, "number", runtime);
      assert.equal(typeof counts?.hookFiles, "number", runtime);
      assert.equal(typeof counts?.commandFiles, "number", runtime);
    }
  });

  test("sync configuration projects only runtime-approved skills", async () => {
    const manifest = await readJson("config/sync.json");
    assert.equal(manifest.canonicalRoots?.skills, "canonical/skills");
    const syncSource = await fs.readFile(
      path.join(repoRoot, "scripts", "sync-runtimes.mjs"),
      "utf8",
    );
    const canonicalSkillIds = await listCanonicalSkillIds();
    assert.ok(
      canonicalSkillIds.includes("same-set-reusable-flow-for-project-file-inventor"),
      "internal canonical skills may remain available without becoming project runtime skills",
    );
    const allowlistMatch = syncSource.match(/PROJECT_RUNTIME_SKILL_IDS = new Set\(\[(.*?)\]\)/s);
    assert.ok(allowlistMatch, "sync must declare an explicit project runtime skill allowlist");
    assert.match(allowlistMatch[1], /"meta-theory"/);
    assert.doesNotMatch(
      allowlistMatch[1],
      /same-set-reusable-flow-for-project-file-inventor/,
    );
    assert.match(syncSource, /pruneNonProjectedRuntimeSkills/);
    assert.ok(
      manifest.generatedTargets?.codex?.includes(".agents/skills"),
      "Codex project skill projection must include the official .agents/skills root.",
    );
    assert.equal(
      manifest.generatedTargets?.codex?.includes(".codex/skills"),
      false,
      "Codex project skill projection must not regenerate the legacy .codex/skills root.",
    );

    for (const runtimeId of ["claude", "codex", "openclaw", "cursor"]) {
      const projection = resolveRuntimeProjection(runtimeId, "project");
      assert.ok(
        projection.skillsDir,
        `${runtimeId} projection must expose a runtime skills directory`,
      );
      assert.equal(
        projection.skillsDir.endsWith(path.join("skills")),
        true,
        `${runtimeId} projection skillsDir must point at the runtime skills root`,
      );
      assert.ok(
        projection.capabilityIndexDir,
        `${runtimeId} projection must expose a capability index mirror directory`,
      );
    }

    const codexProjection = resolveRuntimeProjection("codex", "project");
    assert.equal(
      codexProjection.skillsDir.endsWith(path.join(".agents", "skills")),
      true,
      "Codex project projection must expose .agents/skills as the project skill root.",
    );
    assert.equal(
      "projectSkillsDir" in codexProjection,
      false,
      "Codex project projection must not expose a second project skill root.",
    );
  });

  test("release verification checks canonical discovery read-only before mirror sync", async () => {
    const pkg = await readJson("package.json");
    const releaseScript = await fs.readFile(
      path.join(repoRoot, "scripts", "run-verify-all.mjs"),
      "utf8",
    );
    assert.match(pkg.scripts?.["meta:verify:all"] ?? "", /run-verify-all\.mjs/);
    assert.match(releaseScript, /npm run discover:global -- --check/u);
    assert.match(releaseScript, /npm run meta:sync/u);
    assert.ok(
      releaseScript.indexOf("npm run discover:global -- --check") <
        releaseScript.indexOf("npm run meta:sync") &&
        releaseScript.indexOf("npm run meta:sync") < releaseScript.indexOf("npm run meta:check"),
      "meta:verify:all must check canonical source read-only, sync mirrors, then validate",
    );

    const liveScript = pkg.scripts?.["meta:verify:all:live"] ?? "";
    assert.match(liveScript, /eval-meta-agents\.mjs/);
    assert.match(liveScript, /--live/);
    assert.doesNotMatch(liveScript, /npm run discover:global|npm run meta:check/);
  });

  test("setup and global dependency installs refresh global capability inventory automatically", async () => {
    const pkg = await readJson("package.json");
    const setupSource = await fs.readFile(path.join(repoRoot, "setup.mjs"), "utf8");
    const installSource = await fs.readFile(
      path.join(repoRoot, "scripts", "install-global-skills-all-runtimes.mjs"),
      "utf8",
    );

    assert.match(setupSource, /function refreshGlobalCapabilityInventory\(activeTargets = \[\]\)/);
    assert.match(
      setupSource,
      /runNodeScript\(SETUP_NODE_CHILD\.CAPABILITY_DISCOVERY, targetArgs, \{\s*META_KIM_LANG: currentLangCode,\s*\}\)/,
      "setup.mjs must run global discovery directly for the selected runtime targets",
    );
    assert.match(
      setupSource,
      /"\-\-runtime-inventory-only"/,
      "setup global install/update must refresh runtime inventory without writing project runtime mirrors",
    );
    assert.match(
      setupSource,
      /"\-\-targets", activeTargets\.join\(","\)/,
      "setup.mjs must restrict global discovery to the selected runtime targets",
    );
    assert.match(
      setupSource,
      /await withProgress\(\s*t\.stepLabel\(stepNum, t\.refreshGlobalCapabilityInventory\)/,
      "install flow must refresh the global capability inventory",
    );
    assert.match(
      setupSource,
      /await refreshGlobalCapabilityInventory\(activeTargets\);\s*\n\s*}\s*\n\s*\/\/ Copy runtime files before validating their final target state/,
      "update flow must refresh the global capability inventory before final sync checks",
    );

    assert.match(installSource, /function refreshGlobalCapabilityInventory\(activeTargets = \[\]\)/);
    assert.match(
      installSource,
      /"--targets",\s*activeTargets\.join\(","\)/,
      "global skill dependency installer must restrict discovery to the selected runtime targets",
    );
    assert.match(
      installSource,
      /"\-\-runtime-inventory-only"/,
      "global skill dependency installer must not refresh project runtime mirrors during global install/update",
    );
    assert.match(
      installSource,
      /discover-global-capabilities\.mjs/,
      "global skill dependency installer must refresh discovery after mutating runtime homes",
    );
    assert.match(
      pkg.scripts?.["meta:deps:install"] ?? "",
      /install-global-skills-all-runtimes\.mjs/,
    );
    assert.match(
      pkg.scripts?.["meta:deps:update"] ?? "",
      /install-global-skills-all-runtimes\.mjs --update/,
    );
  });

  test("global discovery keeps volatile timestamps stable when canonical capability content is unchanged", () => {
    const existing = {
      generatedAt: "2026-05-23T21:39:16.715Z",
      registryName: "meta-kim-capabilities",
      summary: { totalAgents: 9 },
      byCapabilityType: {
        mcpServers: {
          "repo:repo-mcp:meta-kim-runtime": {
            id: "meta-kim-runtime",
            size: 237,
            modified: "2026-05-20T05:24:46.853Z",
          },
        },
      },
    };
    const next = {
      generatedAt: "2026-05-23T21:45:13.184Z",
      registryName: "meta-kim-capabilities",
      summary: { totalAgents: 9 },
      byCapabilityType: {
        mcpServers: {
          "repo:repo-mcp:meta-kim-runtime": {
            id: "meta-kim-runtime",
            size: 220,
            modified: "2026-05-24T09:13:38.181Z",
          },
        },
      },
    };

    assert.deepEqual(
      preserveGeneratedAtWhenUnchanged(next, existing),
      existing,
      "pure regeneration must not dirty canonical capability index timestamps or stat sizes",
    );
    assert.equal(
      preserveGeneratedAtWhenUnchanged(
        { ...next, summary: { totalAgents: 10 } },
        existing,
      ).generatedAt,
      next.generatedAt,
      "real capability content changes must keep the new generation timestamp",
    );
  });

  test("project validator enforces the capability index schema contract", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts", "validate-project.mjs"),
      "utf8",
    );
    assert.match(source, /capability-index\.schema\.json/);
    assert.match(source, /validateCapabilityIndexSchema/);
    assert.match(source, /schemaNode\.required/);
  });

  test("project validator skips project-local capability mirror validation only in global_only mode", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts", "validate-project.mjs"),
      "utf8",
    );

    const schemaCheckIndex = source.indexOf("await validateCapabilityIndexSchema(index);");
    const canonicalReadIndex = source.indexOf(
      'const canonicalContent = await fs.readFile(indexPath, "utf8");',
    );
    const globalOnlySkipIndex = source.indexOf(
      'if (projectProjectionMode === "global_only")',
    );
    const mirrorLoopIndex = source.indexOf(
      "for (const mirror of index.mirroredTo ?? [])",
    );

    assert.notEqual(schemaCheckIndex, -1);
    assert.notEqual(canonicalReadIndex, -1);
    assert.notEqual(globalOnlySkipIndex, -1);
    assert.notEqual(mirrorLoopIndex, -1);
    assert.ok(
      schemaCheckIndex < globalOnlySkipIndex &&
        canonicalReadIndex < globalOnlySkipIndex &&
        globalOnlySkipIndex < mirrorLoopIndex,
      "global_only skip must happen after canonical checks and before project-local mirror validation",
    );
    assert.match(source, /skip project-local mirror validation/);
  });

  test("capability index declares abstract slots and run-only runtime skill selections", async () => {
    const index = await readJson("config/capability-index/meta-kim-capabilities.json");
    const providerIds = [
      "meta-theory",
      "agent-teams-playbook",
      "superpowers",
      "ecc",
      "findskill",
    ];

    assert.ok(Array.isArray(index.abstractCapabilitySlots));
    assert.ok(index.abstractCapabilitySlots.length >= 1);
    assert.ok(
      index.abstractCapabilitySlots.some(
        (slot) => slot.slotId === "interface-integration-contract",
      ),
      "capability index must expose the abstract interface integration contract slot",
    );
    assert.equal(
      index.longTermAgentIdentityPolicy?.forbidConcreteSkillInLongTermAgentIdentity,
      true,
    );
    assert.equal(index.runtimeSelectedSkills?.selectedSkillScope, "run_only");

    for (const providerId of providerIds) {
      assert.equal(
        index.metaSkillProviders?.[providerId]?.allowedForLongTermAgentIdentity,
        true,
        `${providerId} must be allowed as a long-term meta-skill package provider`,
      );
      assert.ok(
        index.longTermAgentIdentityPolicy?.allowedMetaSkillProviderIds?.includes(providerId),
        `${providerId} must be listed in the long-term identity provider allowlist`,
      );
    }

    for (const slot of index.abstractCapabilitySlots) {
      assert.ok(slot.slotId, "abstract capability slots need stable ids");
      assert.equal(slot.selectedSkillScope, "run_only");
      assert.ok(Array.isArray(slot.allowedProviderIds));
      assert.ok(slot.allowedProviderIds.length >= 1);
    }
  });

  test("schema requires the capability slot/provider/runtime selection contract", async () => {
    const schema = await readJson("config/contracts/capability-index.schema.json");

    for (const field of [
      "abstractCapabilitySlots",
      "metaSkillProviders",
      "runtimeSelectedSkills",
      "longTermAgentIdentityPolicy",
    ]) {
      assert.ok(schema.required.includes(field), `schema must require ${field}`);
      assert.ok(schema.properties?.[field], `schema must define ${field}`);
    }

    assert.deepEqual(
      schema.properties.runtimeSelectedSkills.properties.selectedSkillScope.enum,
      ["run_only"],
    );
    assert.deepEqual(
      schema.properties.longTermAgentIdentityPolicy.properties
        .forbidConcreteSkillInLongTermAgentIdentity.const,
      true,
    );
  });
});
