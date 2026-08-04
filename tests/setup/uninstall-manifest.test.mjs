import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  atomicRewriteFileFromSnapshot,
  manifestEntryToFinding,
  findingsFromManifest,
  orderUninstallActions,
  removeManagedFileIfUnchanged,
  removeManagedMcpFragmentFromFile,
  removeExactManagedDirectory,
  removeExactManagedRuntimeBundle,
  removeExactManagedRuntimeBundleWithLock,
  revertManagedTomlFragments,
  stripManagedSettingsFile,
  writeDurableStagedFile,
} from "../../scripts/uninstall.mjs";
import {
  resolveGlobalProjectionPackageLayout,
  withProjectionDigestLock,
} from "../../scripts/global-projection-package-store.mjs";
import { mcpDefinitionFingerprint } from "../../scripts/global-runtime-mcp.mjs";
import {
  createEmpty,
  record,
  writeManifest,
  manifestPathFor,
  CATEGORIES,
  directoryClosureSync,
  openRecorder,
} from "../../scripts/install-manifest.mjs";
import { planCodexAppNativeControls } from "../../scripts/codex-config-merge.mjs";
import { resolveMcpMemoryBootArtifactDescriptors } from "../../scripts/mcp-memory-boot-artifacts.mjs";

function withTmpRepo(body) {
  const dir = mkdtempSync(path.join(tmpdir(), "meta-kim-uninstall-"));
  mkdirSync(path.join(dir, ".meta-kim"), { recursive: true });
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const PRIMARY_PROJECTION_BUNDLE_PURPOSE =
  "primary-runtime-global-projection-package-runtime-bundle";

function runUninstall(userHome, args) {
  return spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "uninstall.mjs"), ...args],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: userHome,
        USERPROFILE: userHome,
        META_KIM_CLAUDE_HOME: path.join(userHome, ".claude"),
        META_KIM_CODEX_HOME: path.join(userHome, ".codex"),
      },
    },
  );
}

function writeGlobalManifest(userHome, entries) {
  const manifestPath = path.join(userHome, ".meta-kim", "install-manifest.json");
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    scope: "global",
    metaKimVersion: "test",
    createdAt: now,
    updatedAt: now,
    entries,
  }, null, 2)}\n`);
  return manifestPath;
}

function createManagedBundle(repo) {
  const bundle = path.join(repo, ".meta-kim", "runtime", "package", "version");
  const packageRoot = path.join(bundle, "node_modules", "package");
  const proofByRole = {
    "package-manifest": path.join(packageRoot, "package.json"),
    cli: path.join(packageRoot, "bin", "cli.mjs"),
    server: path.join(packageRoot, "scripts", "mcp", "server.mjs"),
  };
  for (const [role, filePath] of Object.entries(proofByRole)) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${role}\n`);
  }
  const dependency = path.join(bundle, "node_modules", "dependency", "index.js");
  mkdirSync(path.dirname(dependency), { recursive: true });
  writeFileSync(dependency, "dependency\n");
  const closure = directoryClosureSync(bundle);
  const proofFiles = Object.entries(proofByRole).map(([role, filePath]) => {
    const bytes = readFileSync(filePath);
    return { path: filePath, role, size: bytes.length, sha256: sha256(bytes) };
  });
  return {
    bundle,
    proofByRole,
    action: {
      path: bundle,
      manifestManaged: true,
      source: "sync-global-meta-theory",
      purpose: "claude-global-mcp-runtime-bundle",
      closureSha256: closure.sha256,
      closureEntryCount: closure.entryCount,
      proofFiles: proofFiles.map((proof) => ({
        ...proof,
        kind: "file",
        source: "sync-global-meta-theory",
      })),
    },
  };
}

function createPrimaryProjectionBundle(repo, { storeRoot = null } = {}) {
  const digest = "a".repeat(64);
  const versionRoot = path.join(
    storeRoot ?? path.join(repo, ".meta-kim", "runtime", "projection-packages"),
    "meta-kim",
    "2.0.22",
  );
  const digestDir = path.join(versionRoot, digest);
  const packageRoot = path.join(digestDir, "bundle", "node_modules", "meta-kim");
  const proofByRole = {
    receipt: path.join(digestDir, "receipt.json"),
    "package-manifest": path.join(packageRoot, "package.json"),
    cli: path.join(packageRoot, "bin", "meta-kim.mjs"),
    "sync-script": path.join(packageRoot, "scripts", "sync-global-meta-theory.mjs"),
  };
  mkdirSync(path.dirname(proofByRole["package-manifest"]), { recursive: true });
  mkdirSync(path.dirname(proofByRole.cli), { recursive: true });
  mkdirSync(path.dirname(proofByRole["sync-script"]), { recursive: true });
  writeFileSync(
    proofByRole["package-manifest"],
    `${JSON.stringify({
      name: "meta-kim",
      version: "2.0.22",
      type: "module",
      bin: { "meta-kim": "bin/meta-kim.mjs" },
    })}\n`,
  );
  writeFileSync(proofByRole.cli, "cli\n");
  writeFileSync(proofByRole["sync-script"], "sync-script\n");
  const dependency = path.join(digestDir, "bundle", "node_modules", "dependency", "index.js");
  mkdirSync(path.dirname(dependency), { recursive: true });
  writeFileSync(dependency, "dependency\n");
  const firstPartyFiles = [
    "bin/meta-kim.mjs",
    "package.json",
    "scripts/sync-global-meta-theory.mjs",
  ];
  const firstPartyEntries = firstPartyFiles.map((relativePath) => {
    const bytes = readFileSync(path.join(packageRoot, ...relativePath.split("/")));
    return { path: relativePath, size: bytes.length, sha256: sha256(bytes) };
  });
  const keyFiles = {};
  for (const [key, filePath] of Object.entries({
    packageManifest: proofByRole["package-manifest"],
    publicCli: proofByRole.cli,
    globalSyncScript: proofByRole["sync-script"],
  })) {
    const bytes = readFileSync(filePath);
    keyFiles[key] = {
      relativePath: path.relative(digestDir, filePath).replaceAll("\\", "/"),
      size: bytes.length,
      sha256: sha256(bytes),
    };
  }
  const receipt = {
    schemaVersion: "meta-kim-global-projection-package-v1",
    packageName: "meta-kim",
    packageVersion: "2.0.22",
    packageTarballSha256: digest,
    firstPartyFiles,
    firstPartyClosure: {
      entryCount: firstPartyEntries.length,
      sha256: sha256(Buffer.from(JSON.stringify(firstPartyEntries), "utf8")),
    },
    bundleRelativePath: "bundle",
    packageRootRelative: path.relative(digestDir, packageRoot).replaceAll("\\", "/"),
    bundleClosure: directoryClosureSync(path.join(digestDir, "bundle")),
    keyFiles,
  };
  writeFileSync(proofByRole.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  const closure = directoryClosureSync(digestDir);
  const proofFiles = Object.entries(proofByRole).map(([role, filePath]) => {
    const bytes = readFileSync(filePath);
    return {
      path: filePath,
      role,
      kind: "file",
      source: "sync-global-meta-theory",
      size: bytes.length,
      sha256: sha256(bytes),
    };
  });
  return {
    digestDir,
    proofByRole,
    action: {
      path: digestDir,
      manifestManaged: true,
      source: "sync-global-meta-theory",
      purpose: PRIMARY_PROJECTION_BUNDLE_PURPOSE,
      closureSha256: closure.sha256,
      closureEntryCount: closure.entryCount,
      proofFiles,
    },
  };
}

function refreshPrimaryBundleAction(bundle, roles = ["receipt"]) {
  for (const role of roles) {
    const proof = bundle.action.proofFiles.find((candidate) => candidate.role === role);
    const bytes = readFileSync(bundle.proofByRole[role]);
    proof.size = bytes.length;
    proof.sha256 = sha256(bytes);
  }
  const closure = directoryClosureSync(bundle.digestDir);
  bundle.action.closureSha256 = closure.sha256;
  bundle.action.closureEntryCount = closure.entryCount;
  return bundle;
}

function primaryBundleManifestEntries(bundle) {
  const installedAt = new Date().toISOString();
  return [
    {
      path: bundle.digestDir,
      category: CATEGORIES.C,
      source: bundle.action.source,
      purpose: bundle.action.purpose,
      kind: "dir",
      ownershipClass: "install_projection",
      directoryClosureSha256: bundle.action.closureSha256,
      directoryClosureEntryCount: bundle.action.closureEntryCount,
      installedAt,
    },
    ...bundle.action.proofFiles.map((proof) => ({
      path: proof.path,
      category: CATEGORIES.C,
      source: proof.source,
      purpose: `${bundle.action.purpose}:${proof.role}`,
      kind: proof.kind,
      ownershipClass: "install_projection",
      size: proof.size,
      sha256: proof.sha256,
      installedAt,
    })),
  ];
}

describe("uninstall / manifestEntryToFinding", () => {
  test("maps a file entry to a file finding", () => {
    const finding = manifestEntryToFinding({
      path: "/repo/.claude/settings.json",
      category: CATEGORIES.G,
      source: "sync-runtimes",
      purpose: "project-settings",
      kind: "file",
      size: 512,
      sha256: "a".repeat(64),
    });
    assert.equal(finding.kind, "file");
    assert.equal(finding.path, "/repo/.claude/settings.json");
    assert.equal(finding.category, CATEGORIES.G);
    assert.equal(finding.source, "sync-runtimes");
    assert.equal(finding.purpose, "project-settings");
    assert.equal(finding.size, 512);
    assert.equal(finding.sha256, "a".repeat(64));
    assert.equal(finding.manifestManaged, true);
  });

  test("maps a dir entry to a dir finding", () => {
    const finding = manifestEntryToFinding({
      path: "/home/kim/.claude/skills/meta-theory",
      category: CATEGORIES.A,
      kind: "dir",
    });
    assert.equal(finding.kind, "dir");
  });

  test("maps settings-merge entry with mergedHookCommands", () => {
    const finding = manifestEntryToFinding({
      path: "/home/kim/.claude/settings.json",
      category: CATEGORIES.C,
      kind: "settings-merge",
      mergedHookCommands: ["node a.mjs", "node b.mjs", "node c.mjs"],
    });
    assert.equal(finding.kind, "settings-merge");
    assert.equal(finding.managedHookCount, 3);
    assert.equal(finding.managedHooks.length, 3);
    assert.equal(finding.managedHooks[0].command, "node a.mjs");
    assert.equal(finding.managedHooks[0].event, null);
    assert.equal(finding.managedHooks[0].matcher, null);
  });

  test("maps structured settings hook fragments as the authoritative ownership record", () => {
    const fragment = {
      event: "PreToolUse",
      matcher: "Bash",
      hook: {
        type: "command",
        command: "node hooks/meta-kim/check.mjs",
        timeout: 30,
      },
    };
    const finding = manifestEntryToFinding({
      path: "/home/kim/.claude/settings.json",
      category: CATEGORIES.C,
      kind: "settings-merge",
      mergedHookCommands: ["legacy command must not override the fragment count"],
      mergedHookFragments: [fragment],
    });
    assert.equal(finding.managedHookCount, 1);
    assert.deepEqual(finding.managedHookFragments, [fragment]);
  });

  test("settings-merge without mergedHookCommands defaults to empty array", () => {
    const finding = manifestEntryToFinding({
      path: "/x/settings.json",
      category: CATEGORIES.C,
      kind: "settings-merge",
    });
    assert.equal(finding.managedHookCount, 0);
    assert.deepEqual(finding.managedHooks, []);
  });

  test("returns null for pip-package entries", () => {
    const finding = manifestEntryToFinding({
      path: "pip:graphifyy",
      category: CATEGORIES.I,
      kind: "pip-package",
      pipPackageName: "graphifyy",
    });
    assert.equal(finding, null);
  });

  test("maps mcp-server entries to exact-fragment findings", () => {
    const finding = manifestEntryToFinding({
      path: "/x/.mcp.json",
      category: CATEGORIES.G,
      kind: "mcp-server",
      mcpServerName: "meta_kim_runtime",
      mcpServerFingerprint: "sha256",
    });
    assert.equal(finding.kind, "mcp-server");
    assert.equal(finding.mcpServerName, "meta_kim_runtime");
    assert.equal(finding.mcpServerFingerprint, "sha256");
  });

  test("returns null for git-hook entries", () => {
    const finding = manifestEntryToFinding({
      path: "/repo/.git/hooks/post-commit",
      category: CATEGORIES.I,
      kind: "git-hook",
    });
    assert.equal(finding, null);
  });

  test("returns null when path or category is missing", () => {
    assert.equal(manifestEntryToFinding(null), null);
    assert.equal(manifestEntryToFinding(undefined), null);
    assert.equal(manifestEntryToFinding({}), null);
    assert.equal(manifestEntryToFinding({ path: "/x" }), null);
    assert.equal(manifestEntryToFinding({ category: CATEGORIES.A }), null);
  });

  test("preserves source when entry.source is missing", () => {
    const finding = manifestEntryToFinding({
      path: "/x/y.md",
      category: CATEGORIES.D,
      kind: "file",
    });
    assert.equal(finding.source, "manifest");
  });
});

describe("uninstall / findingsFromManifest", () => {
  test("returns empty array when no manifest exists", () => {
    withTmpRepo((repo) => {
      const findings = findingsFromManifest({
        scope: "project",
        repoRoot: repo,
      });
      assert.deepEqual(findings, []);
    });
  });

  test("reads project manifest entries when scope includes project", () => {
    withTmpRepo((repo) => {
      let m = createEmpty({
        scope: "project",
        repoRoot: repo,
        metaKimVersion: "2.0.13",
      });
      m = record(m, {
        path: path.join(repo, ".claude/agents/meta-warden.md"),
        category: CATEGORIES.F,
        source: "sync-runtimes",
        purpose: "project-agent",
        kind: "file",
      });
      m = record(m, {
        path: path.join(repo, ".claude/hooks/post-format.mjs"),
        category: CATEGORIES.E,
        source: "sync-runtimes",
        purpose: "project-hook",
        kind: "file",
      });
      writeManifest(manifestPathFor("project", repo), m);

      const findings = findingsFromManifest({
        scope: "project",
        repoRoot: repo,
      });
      assert.equal(findings.length, 2);
      assert.equal(findings[0].category, CATEGORIES.F);
      assert.equal(findings[1].category, CATEGORIES.E);
    });
  });

  test("filters out non-actionable entry kinds (pip/git-hook)", () => {
    withTmpRepo((repo) => {
      let m = createEmpty({
        scope: "project",
        repoRoot: repo,
        metaKimVersion: "2.0.13",
      });
      m = record(m, {
        path: path.join(repo, ".claude/agents/meta-warden.md"),
        category: CATEGORIES.F,
        purpose: "project-agent",
        kind: "file",
      });
      m = record(m, {
        path: "pip:graphifyy",
        category: CATEGORIES.I,
        purpose: "pip-package:graphifyy",
        kind: "pip-package",
      });
      m = record(m, {
        path: path.join(repo, ".git/hooks/post-commit"),
        category: CATEGORIES.I,
        purpose: "graphify-git-hook",
        kind: "git-hook",
      });
      writeManifest(manifestPathFor("project", repo), m);

      const findings = findingsFromManifest({
        scope: "project",
        repoRoot: repo,
      });
      assert.equal(findings.length, 1);
      assert.equal(findings[0].category, CATEGORIES.F);
    });
  });

  test("returns empty array when scope is global and no global manifest", () => {
    withTmpRepo((repo) => {
      let m = createEmpty({
        scope: "project",
        repoRoot: repo,
        metaKimVersion: "2.0.13",
      });
      m = record(m, {
        path: path.join(repo, ".claude/agents/meta-warden.md"),
        category: CATEGORIES.F,
        kind: "file",
      });
      writeManifest(manifestPathFor("project", repo), m);

      const findings = findingsFromManifest({
        scope: "project",
        repoRoot: repo,
      });
      assert.equal(findings.length, 1);
    });
  });

  test("corrupt / unreadable manifest returns empty array, never throws", () => {
    withTmpRepo((repo) => {
      writeFileSync(manifestPathFor("project", repo), "not-json");
      const findings = findingsFromManifest({
        scope: "project",
        repoRoot: repo,
      });
      assert.deepEqual(findings, []);
    });
  });

  test("attaches bundle proof files without turning them into standalone actions", () => {
    withTmpRepo((repo) => {
      const { bundle, action } = createManagedBundle(repo);
      let manifest = createEmpty({ scope: "project", repoRoot: repo, metaKimVersion: "test" });
      manifest = record(manifest, {
        path: bundle,
        category: CATEGORIES.C,
        source: "sync-global-meta-theory",
        purpose: "claude-global-mcp-runtime-bundle",
        kind: "dir",
        directoryClosureSha256: action.closureSha256,
        directoryClosureEntryCount: action.closureEntryCount,
      });
      for (const proof of action.proofFiles) {
        manifest = record(manifest, {
          path: proof.path,
          category: CATEGORIES.C,
          source: "sync-global-meta-theory",
          purpose: `claude-global-mcp-runtime-bundle:${proof.role}`,
          kind: "file",
          size: proof.size,
          sha256: proof.sha256,
        });
      }
      const invalidExtra = path.join(repo, "outside-candidate.lock");
      writeFileSync(invalidExtra, "outside\n");
      manifest = record(manifest, {
        path: invalidExtra,
        category: CATEGORIES.C,
        source: "other-source",
        purpose: "claude-global-mcp-runtime-bundle:candidate-lock",
        kind: "file",
        size: readFileSync(invalidExtra).length,
        sha256: sha256(readFileSync(invalidExtra)),
      });
      writeManifest(manifestPathFor("project", repo), manifest);

      const findings = findingsFromManifest({ scope: "project", repoRoot: repo });
      assert.equal(findings.length, 1);
      assert.equal(findings[0].kind, "dir");
      assert.deepEqual(
        findings[0].bundleProofFiles.map((proof) => proof.role).sort(),
        ["candidate-lock", "cli", "package-manifest", "server"],
      );
    });
  });

  test("groups primary projection receipt and runtime proofs into one bundle action", () => {
    withTmpRepo((repo) => {
      const { digestDir, action } = createPrimaryProjectionBundle(repo);
      let manifest = createEmpty({ scope: "project", repoRoot: repo, metaKimVersion: "test" });
      manifest = record(manifest, {
        path: digestDir,
        category: CATEGORIES.C,
        source: action.source,
        purpose: action.purpose,
        kind: "dir",
        directoryClosureSha256: action.closureSha256,
        directoryClosureEntryCount: action.closureEntryCount,
      });
      for (const proof of action.proofFiles) {
        manifest = record(manifest, {
          path: proof.path,
          category: CATEGORIES.C,
          source: proof.source,
          purpose: `${action.purpose}:${proof.role}`,
          kind: proof.kind,
          size: proof.size,
          sha256: proof.sha256,
        });
      }
      writeManifest(manifestPathFor("project", repo), manifest);

      const findings = findingsFromManifest({ scope: "project", repoRoot: repo });
      assert.equal(findings.length, 1);
      assert.equal(findings[0].kind, "dir");
      assert.equal(findings[0].purpose, PRIMARY_PROJECTION_BUNDLE_PURPOSE);
      assert.deepEqual(
        findings[0].bundleProofFiles.map((proof) => proof.role).sort(),
        ["cli", "package-manifest", "receipt", "sync-script"],
      );
    });
  });
});

describe("uninstall / manifest fail-closed CLI", () => {
  test("an exact future MCP Memory Startup manifest entry is removed with hash and identity enforcement", {
    skip: process.platform !== "win32",
  }, () => {
    withTmpRepo((home) => {
      const entry = resolveMcpMemoryBootArtifactDescriptors({ homeRoot: home, platformName: "win32" })
        .find((candidate) => candidate.id === "windows-startup");
      mkdirSync(path.dirname(entry.path), { recursive: true });
      const commandPath = path.win32.join(home, ".meta-kim", "mcp-memory-start.cmd");
      const bytes = Buffer.from(
        `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${commandPath}""", 0, False\r\n`,
        "utf8",
      );
      writeFileSync(entry.path, bytes);
      writeGlobalManifest(home, [{
        ...entry,
        size: bytes.length,
        sha256: sha256(bytes),
        installedAt: new Date().toISOString(),
      }]);

      const result = runUninstall(home, ["--scope=global", "--yes"]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(existsSync(entry.path), false);
    });
  });

  test("an exact Windows MCP Memory manifest removes the complete three-file boot chain", {
    skip: process.platform !== "win32",
  }, () => {
    withTmpRepo((home) => {
      const descriptors = resolveMcpMemoryBootArtifactDescriptors({
        homeRoot: home,
        platformName: "win32",
      });
      const entries = descriptors.map((descriptor) => {
        const bytes = Buffer.from(`managed ${descriptor.id}\r\n`, "utf8");
        mkdirSync(path.dirname(descriptor.path), { recursive: true });
        writeFileSync(descriptor.path, bytes);
        return {
          ...descriptor,
          size: bytes.length,
          sha256: sha256(bytes),
          installedAt: new Date().toISOString(),
        };
      });
      writeGlobalManifest(home, entries);

      const result = runUninstall(home, ["--scope=global", "--yes"]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      for (const descriptor of descriptors) {
        assert.equal(existsSync(descriptor.path), false, descriptor.id);
      }
    });
  });

  test("forged MCP Memory identity is blocked and drifted manifest content is preserved", {
    skip: process.platform !== "win32",
  }, () => {
    withTmpRepo((home) => {
      const entry = resolveMcpMemoryBootArtifactDescriptors({ homeRoot: home, platformName: "win32" })
        .find((candidate) => candidate.id === "windows-startup");
      mkdirSync(path.dirname(entry.path), { recursive: true });
      const managed = Buffer.from("managed startup\n", "utf8");
      writeFileSync(entry.path, managed);
      writeGlobalManifest(home, [{
        ...entry,
        purpose: `${entry.purpose}:forged`,
        size: managed.length,
        sha256: sha256(managed),
        installedAt: new Date().toISOString(),
      }]);
      const forged = runUninstall(home, ["--scope=global", "--yes"]);
      assert.notEqual(forged.status, 0, `${forged.stdout}\n${forged.stderr}`);
      assert.match(`${forged.stdout}\n${forged.stderr}`, /manifest_entry_untrusted/iu);
      assert.deepEqual(readFileSync(entry.path), managed);

      writeGlobalManifest(home, [{
        ...entry,
        size: managed.length,
        sha256: sha256(managed),
        installedAt: new Date().toISOString(),
      }]);
      const changed = Buffer.from("user changed startup\n", "utf8");
      writeFileSync(entry.path, changed);
      const drifted = runUninstall(home, ["--scope=global", "--yes"]);
      assert.notEqual(drifted.status, 0, `${drifted.stdout}\n${drifted.stderr}`);
      assert.match(`${drifted.stdout}\n${drifted.stderr}`, /Preserved user-modified/iu);
      assert.deepEqual(readFileSync(entry.path), changed);
    });
  });

  test("opt-in recovery dry-run preserves and live run removes only an exact orphan Startup VBS", {
    skip: process.platform !== "win32",
  }, () => {
    withTmpRepo((home) => {
      const entry = resolveMcpMemoryBootArtifactDescriptors({ homeRoot: home, platformName: "win32" })
        .find((candidate) => candidate.id === "windows-startup");
      mkdirSync(path.dirname(entry.path), { recursive: true });
      const commandPath = path.win32.join(home, ".meta-kim", "mcp-memory-start.cmd");
      writeFileSync(
        entry.path,
        `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${commandPath}""", 0, False\r\n`,
      );
      const unrelated = path.join(path.dirname(entry.path), "user-startup.vbs");
      writeFileSync(unrelated, "user owned\r\n");
      const dependencySentinel = path.win32.join(
        home,
        ".meta-kim",
        "memory-venv",
        "Lib",
        "site-packages",
        "mcp_memory_service",
        "__init__.py",
      );
      mkdirSync(path.dirname(dependencySentinel), { recursive: true });
      writeFileSync(dependencySentinel, "# preserve installed dependency\n");

      const dryRun = runUninstall(home, ["--recover", "--scope=global"]);
      assert.equal(dryRun.status, 0, `${dryRun.stdout}\n${dryRun.stderr}`);
      assert.match(dryRun.stdout, /exact-signature legacy recovery/iu);
      assert.match(dryRun.stdout, /complete uninstall cannot be proven/iu);
      assert.equal(existsSync(entry.path), true);

      const live = runUninstall(home, ["--recover", "--scope=global", "--yes"]);
      assert.equal(live.status, 0, `${live.stdout}\n${live.stderr}`);
      assert.equal(existsSync(entry.path), false);
      assert.equal(readFileSync(unrelated, "utf8"), "user owned\r\n");
      assert.equal(
        readFileSync(dependencySentinel, "utf8"),
        "# preserve installed dependency\n",
      );
    });
  });

  test("opt-in recovery preserves a modified Startup VBS", {
    skip: process.platform !== "win32",
  }, () => {
    withTmpRepo((home) => {
      const entry = resolveMcpMemoryBootArtifactDescriptors({ homeRoot: home, platformName: "win32" })
        .find((candidate) => candidate.id === "windows-startup");
      mkdirSync(path.dirname(entry.path), { recursive: true });
      const modified = "Set WshShell = CreateObject(\"WScript.Shell\")\r\n' user-owned customization\r\n";
      writeFileSync(entry.path, modified);
      const result = runUninstall(home, ["--recover", "--scope=global", "--yes", "--lang=en"]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(readFileSync(entry.path, "utf8"), modified);
      assert.match(result.stdout, /No exact Meta_Kim boot artifacts were found/iu);
      assert.match(result.stdout, /Nothing changed/iu);
      assert.match(result.stdout, /full cleanup is not proven/iu);
      assert.doesNotMatch(result.stdout, /system is clean|Nothing to do/iu);
    });
  });

  test("public recovery ignores matching-looking user hook and configuration files", () => {
    withTmpRepo((home) => {
      const hookPath = path.join(home, ".claude", "hooks", "meta-kim", "user-memory-hook.mjs");
      const settingsPath = path.join(home, ".claude", "settings.json");
      mkdirSync(path.dirname(hookPath), { recursive: true });
      writeFileSync(hookPath, "// user-owned matching-looking hook\n");
      const settings = `${JSON.stringify({
        hooks: {
          SessionStart: [{
            matcher: null,
            hooks: [{ type: "command", command: `node "${hookPath}"` }],
          }],
        },
      }, null, 2)}\n`;
      mkdirSync(path.dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, settings);

      const result = runUninstall(home, ["--recover", "--scope=global", "--yes", "--lang=en"]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(readFileSync(hookPath, "utf8"), "// user-owned matching-looking hook\n");
      assert.equal(readFileSync(settingsPath, "utf8"), settings);
      assert.match(result.stdout, /No exact Meta_Kim boot artifacts were found/iu);
      assert.doesNotMatch(result.stdout, /system is clean|Nothing to do/iu);
    });
  });

  test("zero-action recovery reports the bounded result in every supported locale", () => {
    const cases = [
      ["en", /No exact Meta_Kim boot artifacts were found[\s\S]*Nothing changed[\s\S]*full cleanup is not proven/iu],
      ["zh", /未发现可精确识别的 Meta_Kim 启动产物[\s\S]*未做任何更改[\s\S]*无法证明已完成全部清理/u],
      ["ja", /厳密に識別できる Meta_Kim 起動生成物は見つかりませんでした[\s\S]*変更はありません[\s\S]*完全なクリーンアップは証明できません/u],
      ["ko", /정확히 식별된 Meta_Kim 시작 산출물을 찾지 못했습니다[\s\S]*변경 사항은 없습니다[\s\S]*전체 정리를 증명할 수 없습니다/u],
    ];
    for (const [language, expected] of cases) {
      withTmpRepo((home) => {
        const result = runUninstall(home, ["--recover", "--scope=global", `--lang=${language}`]);
        assert.equal(result.status, 0, `${language}\n${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, expected, language);
      });
    }
  });

  test("global manifest cannot authorize a file outside profile-derived ownership roots", () => {
    withTmpRepo((home) => {
      const victim = path.join(home, "user-owned.txt");
      const bytes = Buffer.from("USER OWNED\n", "utf8");
      writeFileSync(victim, bytes);
      writeGlobalManifest(home, [{
        path: victim,
        category: CATEGORIES.A,
        source: "sync-global-meta-theory",
        purpose: "claude-global-skill",
        kind: "file",
        size: bytes.length,
        sha256: sha256(bytes),
        installedAt: new Date().toISOString(),
      }]);

      const result = runUninstall(home, ["--scope=global", "--yes"]);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /manifest_entry_untrusted/iu);
      assert.deepEqual(readFileSync(victim), bytes);
    });
  });

  test("a forged Agent purpose cannot delete a user file inside a runtime skill root", () => {
    withTmpRepo((home) => {
      const victim = path.join(home, ".claude", "skills", "user-owned.txt");
      const bytes = Buffer.from("USER OWNED SKILL DATA\n", "utf8");
      mkdirSync(path.dirname(victim), { recursive: true });
      writeFileSync(victim, bytes);
      writeGlobalManifest(home, [{
        path: victim,
        category: CATEGORIES.A,
        source: "sync-global-meta-theory",
        purpose: "claude-global-agent:forged",
        kind: "file",
        size: bytes.length,
        sha256: sha256(bytes),
        installedAt: new Date().toISOString(),
      }]);

      const result = runUninstall(home, ["--scope=global", "--yes"]);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /manifest_entry_untrusted/iu);
      assert.deepEqual(readFileSync(victim), bytes);
    });
  });

  test("global projection policy rejects cross-asset kind purpose and Agent-id spoofing", () => {
    const cases = [
      {
        name: "skill root recorded as a file",
        relPath: [".claude", "skills", "meta-theory"],
        category: CATEGORIES.A,
        purpose: "claude-global-skill",
        kind: "file",
      },
      {
        name: "command path recorded as a hook",
        relPath: [".claude", "commands", "meta-theory.md"],
        category: CATEGORIES.A,
        purpose: "claude-global-hook",
        kind: "file",
      },
      {
        name: "non-canonical Agent id",
        relPath: [".claude", "agents", "meta-forged.md"],
        category: CATEGORIES.A,
        purpose: "claude-global-agent:meta-forged",
        kind: "file",
      },
      {
        name: "hook path recorded as a command",
        relPath: [".claude", "hooks", "meta-kim", "stop-memory-save.mjs"],
        category: CATEGORIES.B,
        purpose: "claude-global-command",
        kind: "file",
      },
    ];

    for (const attack of cases) {
      withTmpRepo((home) => {
        const victim = path.join(home, ...attack.relPath);
        const bytes = Buffer.from(`USER OWNED: ${attack.name}\n`, "utf8");
        mkdirSync(path.dirname(victim), { recursive: true });
        writeFileSync(victim, bytes);
        writeGlobalManifest(home, [{
          path: victim,
          category: attack.category,
          source: "sync-global-meta-theory",
          purpose: attack.purpose,
          kind: attack.kind,
          size: bytes.length,
          sha256: sha256(bytes),
          installedAt: new Date().toISOString(),
        }]);

        const result = runUninstall(home, ["--scope=global", "--yes"]);
        assert.notEqual(
          result.status,
          0,
          `${attack.name}\n${result.stdout}\n${result.stderr}`,
        );
        assert.match(`${result.stdout}\n${result.stderr}`, /manifest_entry_untrusted/iu);
        assert.deepEqual(readFileSync(victim), bytes, attack.name);
      });
    }
  });

  test("OpenClaw child roots cannot fall back to the workspace-wide descriptor", () => {
    withTmpRepo((home) => {
      const victim = path.join(home, ".openclaw", "skills", "user-owned.txt");
      const bytes = Buffer.from("OPENCLAW USER SKILL\n", "utf8");
      mkdirSync(path.dirname(victim), { recursive: true });
      writeFileSync(victim, bytes);
      writeGlobalManifest(home, [{
        path: victim,
        category: CATEGORIES.A,
        source: "sync-runtimes",
        purpose: "openclaw-global-workspacesRoot",
        kind: "file",
        runtimeTarget: "openclaw",
        size: bytes.length,
        sha256: sha256(bytes),
        installedAt: new Date().toISOString(),
      }]);

      const result = runUninstall(home, ["--scope=global", "--yes"]);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /descriptor_identity_mismatch/iu);
      assert.deepEqual(readFileSync(victim), bytes);
    });
  });

  test("OpenClaw workspace ownership is limited to canonical Agent and renderer filenames", () => {
    for (const relPath of [
      [".openclaw", "workspace-meta-warden", "PRIVATE.md"],
      [".openclaw", "workspace-not-a-canonical-agent", "SOUL.md"],
    ]) {
      withTmpRepo((home) => {
        const victim = path.join(home, ...relPath);
        const bytes = Buffer.from("OPENCLAW USER WORKSPACE DATA\n", "utf8");
        mkdirSync(path.dirname(victim), { recursive: true });
        writeFileSync(victim, bytes);
        writeGlobalManifest(home, [{
          path: victim,
          category: CATEGORIES.A,
          source: "sync-runtimes",
          purpose: "openclaw-global-workspacesRoot",
          kind: "file",
          runtimeTarget: "openclaw",
          size: bytes.length,
          sha256: sha256(bytes),
          installedAt: new Date().toISOString(),
        }]);

        const result = runUninstall(home, ["--scope=global", "--yes"]);
        assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.deepEqual(readFileSync(victim), bytes);
      });
    }
  });

  test("a forged sibling durable bundle with self-authored proofs cannot authorize deletion", () => {
    withTmpRepo((home) => {
      const bundle = path.join(
        home,
        ".meta-kim",
        "runtime",
        "meta-kim",
        "user-owned",
      );
      const packageRoot = path.join(bundle, "node_modules", "meta-kim");
      const proofPaths = {
        "package-manifest": path.join(packageRoot, "package.json"),
        cli: path.join(packageRoot, "bin", "meta-kim.mjs"),
        server: path.join(packageRoot, "scripts", "mcp", "meta-runtime-server.mjs"),
      };
      mkdirSync(path.dirname(proofPaths.cli), { recursive: true });
      mkdirSync(path.dirname(proofPaths.server), { recursive: true });
      writeFileSync(proofPaths["package-manifest"], `${JSON.stringify({
        name: "user-owned",
        version: "1.0.0",
        bin: { "meta-kim": "bin/meta-kim.mjs" },
      })}\n`);
      writeFileSync(proofPaths.cli, "USER CLI\n");
      writeFileSync(proofPaths.server, "USER SERVER\n");
      const closure = directoryClosureSync(bundle);
      const purpose = "claude-global-mcp-runtime-bundle";
      const entries = [{
        path: bundle,
        category: CATEGORIES.C,
        source: "sync-global-meta-theory",
        purpose,
        kind: "dir",
        directoryClosureSha256: closure.sha256,
        directoryClosureEntryCount: closure.entryCount,
        installedAt: new Date().toISOString(),
      }];
      for (const [role, filePath] of Object.entries(proofPaths)) {
        const bytes = readFileSync(filePath);
        entries.push({
          path: filePath,
          category: CATEGORIES.C,
          source: "sync-global-meta-theory",
          purpose: `${purpose}:${role}`,
          kind: "file",
          runtimeTarget: "claude",
          size: bytes.length,
          sha256: sha256(bytes),
          installedAt: new Date().toISOString(),
        });
      }
      writeGlobalManifest(home, entries);

      const result = runUninstall(home, ["--scope=global", "--yes"]);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /manifest_entry_untrusted/iu);
      assert.equal(readFileSync(proofPaths.cli, "utf8"), "USER CLI\n");
      assert.equal(existsSync(bundle), true);
    });
  });

  test("profile-derived exact projection files are accepted as merged configuration", () => {
    withTmpRepo((home) => {
      const settingsPath = path.join(home, ".codex", "hooks.json");
      const command = "node hooks/meta-kim/check.mjs";
      const original = `${JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: "Bash",
            hooks: [{ type: "command", command }],
          }],
        },
      }, null, 2)}\n`;
      mkdirSync(path.dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, original);
      writeGlobalManifest(home, [{
        path: settingsPath,
        category: CATEGORIES.C,
        source: "sync-global-meta-theory",
        purpose: "codex-global-hooks-json-merge",
        kind: "settings-merge",
        mergedHookCommands: [command],
        mergedHookFragments: [{
          event: "PreToolUse",
          matcher: "Bash",
          hook: { type: "command", command },
        }],
        installedAt: new Date().toISOString(),
      }]);

      const result = runUninstall(home, ["--scope=global"]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /manifest_entry_untrusted/iu);
      assert.equal(readFileSync(settingsPath, "utf8"), original);
    });
  });

  test("failed reference cleanup preserves the primary projection bundle and reports the blocker", () => {
    withTmpRepo((home) => {
      const bundle = createPrimaryProjectionBundle(home);
      const hooksPath = path.join(home, ".codex", "hooks.json");
      mkdirSync(path.dirname(hooksPath), { recursive: true });
      writeFileSync(hooksPath, "{ invalid json\n", "utf8");
      const managedCommand = `node "${path.join(
        home,
        ".codex",
        "hooks",
        "meta-kim",
        "activate-meta-theory-spine.mjs",
      )}" --package-root "${path.join(
        bundle.digestDir,
        "bundle",
        "node_modules",
        "meta-kim",
      )}"`;
      writeGlobalManifest(home, [
        {
          path: hooksPath,
          category: CATEGORIES.C,
          source: "sync-global-meta-theory",
          purpose: "codex-global-hooks-json-merge",
          kind: "settings-merge",
          ownershipClass: "install_projection",
          mergedHookCommands: [managedCommand],
          mergedHookFragments: [{
            event: "UserPromptSubmit",
            matcher: null,
            hook: { type: "command", command: managedCommand },
          }],
          installedAt: new Date().toISOString(),
        },
        ...primaryBundleManifestEntries(bundle),
      ]);

      const result = runUninstall(home, ["--scope=global", "--yes"]);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /projection_reference_cleanup_failed/iu,
      );
      assert.equal(existsSync(bundle.digestDir), true);
      assert.equal(readFileSync(hooksPath, "utf8"), "{ invalid json\n");
    });
  });

  test("missing manifest exits nonzero without falling back to recursive scan", () => {
    withTmpRepo((home) => {
      const unknown = path.join(home, ".claude", "skills", "meta-theory", "user-owned.txt");
      mkdirSync(path.dirname(unknown), { recursive: true });
      writeFileSync(unknown, "preserve\n");
      const result = runUninstall(home, ["--scope=global", "--yes"]);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /manifest_missing|manifest-less|manifest/iu);
      assert.equal(readFileSync(unknown, "utf8"), "preserve\n");
    });
  });

  test("explicit legacy scan preserves non-empty recursive directories", () => {
    withTmpRepo((home) => {
      const unknown = path.join(home, ".claude", "skills", "meta-theory", "user-owned.txt");
      mkdirSync(path.dirname(unknown), { recursive: true });
      writeFileSync(unknown, "preserve\n");
      const result = runUninstall(home, ["--scope=global", "--no-manifest", "--yes"]);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(readFileSync(unknown, "utf8"), "preserve\n");
    });
  });

  test("corrupt and no-actionable manifests block the real CLI without scan mutation", () => {
    withTmpRepo((home) => {
      const unknown = path.join(home, ".claude", "skills", "meta-theory", "user-owned.txt");
      mkdirSync(path.dirname(unknown), { recursive: true });
      writeFileSync(unknown, "preserve\n");
      const manifestPath = writeGlobalManifest(home, []);
      writeFileSync(manifestPath, "not-json");
      const corrupt = runUninstall(home, ["--scope=global", "--yes"]);
      assert.notEqual(corrupt.status, 0, `${corrupt.stdout}\n${corrupt.stderr}`);
      assert.equal(readFileSync(unknown, "utf8"), "preserve\n");

      writeGlobalManifest(home, []);
      const empty = runUninstall(home, ["--scope=global", "--yes"]);
      assert.notEqual(empty.status, 0, `${empty.stdout}\n${empty.stderr}`);
      assert.equal(readFileSync(unknown, "utf8"), "preserve\n");
    });
  });
});

describe("uninstall / integrity-safe file removal", () => {
  test("a signature recovery file changed after planning is restored instead of deleted", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "mcp-memory-silent.vbs");
      const recognized = Buffer.from("recognized\n", "utf8");
      const concurrent = Buffer.from("USER CONCURRENT EDIT\n", "utf8");
      writeFileSync(target, recognized);
      const result = removeManagedFileIfUnchanged({
        path: target,
        recursive: false,
        manifestManaged: false,
        scanDerived: true,
        scanExact: true,
        recoverySignature: "current-windows-startup-vbs",
        size: recognized.length,
        sha256: sha256(recognized),
      }, {
        beforeMove: () => writeFileSync(target, concurrent),
        homeRoot: repo,
      });
      assert.equal(result.success, false);
      assert.equal(result.preserved, true);
      assert.deepEqual(readFileSync(target), concurrent);
    });
  });

  test("a file changed after preflight is restored instead of deleted", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "managed.txt");
      const managed = Buffer.from("managed\n", "utf8");
      const concurrent = Buffer.from("USER CONCURRENT EDIT\n", "utf8");
      writeFileSync(target, managed);

      const result = removeManagedFileIfUnchanged({
        path: target,
        recursive: false,
        manifestManaged: true,
        size: managed.length,
        sha256: sha256(managed),
      }, {
        beforeMove: () => writeFileSync(target, concurrent),
      });

      assert.equal(result.success, false);
      assert.equal(result.preserved, true);
      assert.match(result.reason, /concurrent_change_before_move:integrity_mismatch/u);
      assert.deepEqual(readFileSync(target), concurrent);
      assert.equal(result.quarantinePath, null);
    });
  });

  test("an MCP Memory boot file beneath a linked ancestor is preserved", {
    skip: process.platform !== "win32",
  }, () => {
    withTmpRepo((home) => {
      const outside = mkdtempSync(path.join(tmpdir(), "meta-kim-uninstall-outside-"));
      const linkedRoot = path.join(home, ".meta-kim");
      const outsideTarget = path.join(outside, "mcp-memory-start.cmd");
      const managed = Buffer.from("managed boot command\r\n", "utf8");
      try {
        rmSync(linkedRoot, { recursive: true, force: true });
        writeFileSync(outsideTarget, managed);
        symlinkSync(outside, linkedRoot, "junction");

        const result = removeManagedFileIfUnchanged({
          path: path.join(linkedRoot, "mcp-memory-start.cmd"),
          recursive: false,
          manifestManaged: true,
          mcpMemoryBootArtifact: true,
          size: managed.length,
          sha256: sha256(managed),
        }, { homeRoot: home });

        assert.equal(result.success, false);
        assert.equal(result.preserved, true);
        assert.match(
          result.reason,
          /^(?:unsafe_file_ancestor|unsafe_mcp_memory_boot_path:.*(?:linked_directory_ancestor|unsafe_directory_type))$/iu,
        );
        assert.deepEqual(readFileSync(outsideTarget), managed);
      } finally {
        rmSync(linkedRoot, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  test("a generic manifest-owned file beneath a linked ancestor is preserved", () => {
    withTmpRepo((home) => {
      const outside = mkdtempSync(path.join(tmpdir(), "meta-kim-uninstall-generic-outside-"));
      const linkedRoot = path.join(home, "managed-link");
      const outsideTarget = path.join(outside, "managed.txt");
      const managed = Buffer.from("manifest-owned bytes\n", "utf8");
      try {
        writeFileSync(outsideTarget, managed);
        try {
          symlinkSync(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");
        } catch (error) {
          if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return;
          throw error;
        }

        const result = removeManagedFileIfUnchanged({
          path: path.join(linkedRoot, "managed.txt"),
          recursive: false,
          manifestManaged: true,
          size: managed.length,
          sha256: sha256(managed),
        });

        assert.equal(result.success, false);
        assert.equal(result.preserved, true);
        assert.equal(result.reason, "unsafe_file_ancestor");
        assert.deepEqual(readFileSync(outsideTarget), managed);
      } finally {
        rmSync(linkedRoot, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  test("removes an unchanged manifest-owned file", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "agents", "governance.md");
      mkdirSync(path.dirname(target), { recursive: true });
      const bytes = Buffer.from("managed\n", "utf8");
      writeFileSync(target, bytes);

      const result = removeManagedFileIfUnchanged({
        path: target,
        recursive: false,
        manifestManaged: true,
        size: bytes.length,
        sha256: sha256(bytes),
      });

      assert.equal(result.success, true);
      assert.equal(existsSync(target), false);
    });
  });

  test("preserves a manifest-owned file after user modification", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "agents", "governance.md");
      mkdirSync(path.dirname(target), { recursive: true });
      const recorded = Buffer.from("managed\n", "utf8");
      const edited = Buffer.from("user edit\n", "utf8");
      writeFileSync(target, edited);

      const result = removeManagedFileIfUnchanged({
        path: target,
        recursive: false,
        manifestManaged: true,
        size: recorded.length,
        sha256: sha256(recorded),
      });

      assert.equal(result.success, false);
      assert.equal(result.preserved, true);
      assert.equal(result.reason, "integrity_mismatch");
      assert.deepEqual(readFileSync(target), edited);
    });
  });

  test("preserves a manifest-owned file when integrity metadata is incomplete", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "managed.txt");
      writeFileSync(target, "managed\n");
      const result = removeManagedFileIfUnchanged({
        path: target,
        recursive: false,
        manifestManaged: true,
        size: null,
        sha256: null,
      });
      assert.equal(result.reason, "missing_integrity");
      assert.equal(existsSync(target), true);
    });
  });

  test("removes an exact manifest-owned recursive directory", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "managed-dir");
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, "owned.txt"), "owned\n");
      const closure = directoryClosureSync(target);
      const result = removeExactManagedDirectory({
        path: target,
        manifestManaged: true,
        recursive: true,
        closureSha256: closure.sha256,
        closureEntryCount: closure.entryCount,
      });
      assert.equal(result.success, true);
      assert.equal(existsSync(target), false);
    });
  });

  test("preserves a recursive directory containing unknown content", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "managed-dir");
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, "owned.txt"), "owned\n");
      const closure = directoryClosureSync(target);
      writeFileSync(path.join(target, "unknown.txt"), "user\n");
      const result = removeExactManagedDirectory({
        path: target,
        manifestManaged: true,
        recursive: true,
        closureSha256: closure.sha256,
        closureEntryCount: closure.entryCount,
      });
      assert.equal(result.success, false);
      assert.equal(result.preserved, true);
      assert.equal(result.reason, "directory_closure_drift");
      assert.equal(existsSync(path.join(target, "unknown.txt")), true);
    });
  });
});

describe("uninstall / managed settings stripping", () => {
  function settingsWithManagedHook() {
    return {
      keep: true,
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{ type: "command", command: "node hooks/meta-kim/check.mjs" }],
        }],
      },
    };
  }

  const actionFor = (target, expectedCount) => ({
    path: target,
    expectedCount,
    predicate: (command) => command.includes("hooks/meta-kim/"),
  });

  test("parse failure is fail-closed", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "settings.json");
      writeFileSync(target, "not json");
      const result = stripManagedSettingsFile(actionFor(target, 1));
      assert.equal(result.success, false);
      assert.equal(result.reason, "invalid_json");
      assert.equal(readFileSync(target, "utf8"), "not json");
    });
  });

  test("expected count mismatch preserves the original settings", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "settings.json");
      const original = `${JSON.stringify(settingsWithManagedHook(), null, 2)}\n`;
      writeFileSync(target, original);
      const result = stripManagedSettingsFile(actionFor(target, 2));
      assert.equal(result.success, false);
      assert.equal(result.reason, "managed_entry_count_mismatch:1/2");
      assert.equal(readFileSync(target, "utf8"), original);
    });
  });

  test("manifest exact fragments never consume a same-directory user hook", () => {
    withTmpRepo((home) => {
      const settingsPath = path.join(home, ".claude", "settings.json");
      mkdirSync(path.dirname(settingsPath), { recursive: true });
      const userCommand = `node "${path.join(home, ".claude", "hooks", "meta-kim", "user-owned-hook.mjs")}"`;
      const recordedCommand = `node "${path.join(home, ".claude", "hooks", "meta-kim", "enforce-agent-dispatch.mjs")}"`;
      const original = Buffer.from(`${JSON.stringify({
        keep: true,
        hooks: {
          PreToolUse: [{
            matcher: "Bash",
            hooks: [{ type: "command", command: userCommand }],
          }],
        },
      }, null, 2)}\n`, "utf8");
      writeFileSync(settingsPath, original);
      writeGlobalManifest(home, [{
        path: settingsPath,
        category: CATEGORIES.C,
        source: "sync-global-meta-theory",
        purpose: "claude-global-settings-merge",
        kind: "settings-merge",
        mergedHookCommands: [recordedCommand],
        mergedHookFragments: [{
          event: "PreToolUse",
          matcher: "Bash",
          hook: { type: "command", command: recordedCommand },
        }],
        mergedSettingsKeys: ["hooks"],
        installedAt: new Date().toISOString(),
      }]);

      const result = runUninstall(home, ["--scope=global", "--yes"]);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /managed_entry_count_mismatch/iu);
      assert.deepEqual(readFileSync(settingsPath), original);
    });
  });

  test("legacy command-only manifests fail safe without deleting matching hooks", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "settings.json");
      const original = `${JSON.stringify(settingsWithManagedHook(), null, 2)}\n`;
      writeFileSync(target, original);
      const result = stripManagedSettingsFile({
        ...actionFor(target, 1),
        requiresExactFragments: true,
        exactFragments: null,
      });
      assert.equal(result.success, false);
      assert.equal(result.reason, "no_exact_managed_fragments_recorded");
      assert.equal(readFileSync(target, "utf8"), original);
    });
  });

  test("structured fragments remove only the exact event matcher and hook object", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "settings.json");
      const managedHook = {
        type: "command",
        command: "node hooks/meta-kim/check.mjs",
        timeout: 30,
      };
      const userHook = {
        type: "command",
        command: "node hooks/meta-kim/user-owned.mjs",
        timeout: 30,
      };
      writeFileSync(target, `${JSON.stringify({
        keep: true,
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [managedHook, userHook] }],
        },
      }, null, 2)}\n`);
      const result = stripManagedSettingsFile({
        path: target,
        expectedCount: 1,
        requiresExactFragments: true,
        exactFragments: [{
          event: "PreToolUse",
          matcher: "Bash",
          hook: managedHook,
        }],
      });
      assert.equal(result.success, true, result.reason);
      const next = JSON.parse(readFileSync(target, "utf8"));
      assert.deepEqual(next.hooks.PreToolUse, [{ matcher: "Bash", hooks: [userHook] }]);
    });
  });

  test("zero recorded or residual matches cannot report success", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "settings.json");
      const original = `${JSON.stringify({ keep: true, hooks: {} }, null, 2)}\n`;
      writeFileSync(target, original);
      const result = stripManagedSettingsFile(actionFor(target, 0));
      assert.equal(result.success, false);
      assert.equal(result.reason, "no_managed_entries_recorded");
      assert.equal(readFileSync(target, "utf8"), original);
    });
  });

  test("concurrent settings changes are preserved by commit-time CAS", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "settings.json");
      const original = Buffer.from(`${JSON.stringify(settingsWithManagedHook(), null, 2)}\n`);
      const concurrent = Buffer.from(`${JSON.stringify({ ...settingsWithManagedHook(), userEdit: true }, null, 2)}\n`);
      writeFileSync(target, original);
      const result = stripManagedSettingsFile(actionFor(target, 1), {
        beforeCommit: () => writeFileSync(target, concurrent),
      });
      assert.equal(result.success, false);
      assert.equal(result.reason, "concurrent_change");
      assert.deepEqual(readFileSync(target), concurrent);
      assert.deepEqual(readFileSync(result.backupPath), original);
    });
  });

  test("staged settings write failure preserves the original bytes", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "settings.json");
      const original = Buffer.from(`${JSON.stringify(settingsWithManagedHook(), null, 2)}\n`);
      writeFileSync(target, original);
      const result = stripManagedSettingsFile(actionFor(target, 1), {
        stageWriter: (request) => {
          if (request.purpose === "replacement") throw new Error("simulated settings write failure");
          writeDurableStagedFile(request);
        },
      });
      assert.equal(result.success, false);
      assert.match(result.reason, /^atomic_write_failed:/u);
      assert.deepEqual(readFileSync(target), original);
      assert.deepEqual(readFileSync(result.backupPath), original);
    });
  });

  test("symlinked settings are rejected without touching the target", () => {
    withTmpRepo((repo) => {
      const realTarget = path.join(repo, "real-settings.json");
      const linkTarget = path.join(repo, "linked-settings.json");
      const original = Buffer.from(`${JSON.stringify(settingsWithManagedHook(), null, 2)}\n`);
      writeFileSync(realTarget, original);
      let retainedTarget = realTarget;
      try {
        symlinkSync(realTarget, linkTarget, "file");
      } catch (error) {
        if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
        const realDirectory = path.join(repo, "real-settings-directory");
        mkdirSync(realDirectory, { recursive: true });
        retainedTarget = path.join(realDirectory, "settings.json");
        writeFileSync(retainedTarget, original);
        symlinkSync(realDirectory, linkTarget, "junction");
      }
      const result = stripManagedSettingsFile(actionFor(linkTarget, 1));
      assert.equal(result.success, false);
      assert.equal(result.reason, "unsafe_settings_file_type");
      assert.equal(lstatSync(linkTarget).isSymbolicLink(), true);
      assert.deepEqual(readFileSync(retainedTarget), original);
    });
  });

  test("real uninstall CLI exits nonzero and preserves symlinked settings bytes", () => {
    withTmpRepo((home) => {
      const realTarget = path.join(home, "real-settings.json");
      const linkTarget = path.join(home, "linked-settings.json");
      const original = Buffer.from(`${JSON.stringify(settingsWithManagedHook(), null, 2)}\n`);
      writeFileSync(realTarget, original);
      let retainedTarget = realTarget;
      try {
        symlinkSync(realTarget, linkTarget, "file");
      } catch (error) {
        if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
        const realDirectory = path.join(home, "real-settings-directory");
        mkdirSync(realDirectory, { recursive: true });
        retainedTarget = path.join(realDirectory, "settings.json");
        writeFileSync(retainedTarget, original);
        symlinkSync(realDirectory, linkTarget, "junction");
      }
      writeGlobalManifest(home, [{
        path: linkTarget,
        category: CATEGORIES.C,
        source: "sync-global-meta-theory",
        purpose: "claude-global-settings-merge",
        kind: "settings-merge",
        mergedHookCommands: ["node hooks/meta-kim/check.mjs"],
        mergedSettingsKeys: ["hooks"],
        installedAt: new Date().toISOString(),
      }]);
      const result = runUninstall(home, ["--scope=global", "--yes"]);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(lstatSync(linkTarget).isSymbolicLink(), true);
      assert.deepEqual(readFileSync(retainedTarget), original);
    });
  });
});

describe("uninstall / managed TOML fragment transaction", () => {
  test("restores false from true while preserving BOM CRLF comments and unmanaged bytes", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "config.toml");
      const original = [
        '\uFEFFmodel = "gpt-5.5" # user model',
        "",
        "[features]",
        "default_mode_request_user_input = false # user comment",
        "js_repl = true",
        "",
      ].join("\r\n");
      const planned = planCodexAppNativeControls(original, {
        platformName: "linux",
      });
      writeFileSync(target, planned.text, "utf8");

      const result = revertManagedTomlFragments({
        path: target,
        mutationJournal: planned.mutations,
      });

      assert.equal(result.success, true, result.reason);
      assert.equal(readFileSync(target, "utf8"), original);
      assert.equal(readFileSync(result.backupPath, "utf8"), planned.text);
    });
  });

  test("managed drift blocks the complete TOML action without changing bytes", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "config.toml");
      const original = [
        "[features]",
        "default_mode_request_user_input = false",
        "js_repl = true",
        "",
      ].join("\n");
      const planned = planCodexAppNativeControls(original, {
        platformName: "linux",
      });
      const drifted = planned.text.replace(
        "default_mode_request_user_input = true",
        "default_mode_request_user_input = false # user took ownership",
      );
      writeFileSync(target, drifted);

      const result = revertManagedTomlFragments({
        path: target,
        mutationJournal: planned.mutations,
      });

      assert.equal(result.success, false);
      assert.match(result.reason, /^toml_fragment_preflight_failed:/u);
      assert.equal(readFileSync(target, "utf8"), drifted);
      assert.equal(result.backupPath, undefined);
    });
  });

  test("commit-time concurrent edits win over TOML rollback", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "config.toml");
      const original = [
        "[features]",
        "default_mode_request_user_input = false",
        "js_repl = true",
        "",
      ].join("\n");
      const planned = planCodexAppNativeControls(original, {
        platformName: "linux",
      });
      const concurrent = `${planned.text}# concurrent user edit\n`;
      writeFileSync(target, planned.text);

      const result = revertManagedTomlFragments(
        { path: target, mutationJournal: planned.mutations },
        { beforeCommit: () => writeFileSync(target, concurrent) },
      );

      assert.equal(result.success, false);
      assert.equal(result.reason, "concurrent_change");
      assert.equal(readFileSync(target, "utf8"), concurrent);
      assert.equal(readFileSync(result.backupPath, "utf8"), planned.text);
    });
  });

  test("legacy fixed-key Codex manifests fail safe in the real CLI", () => {
    withTmpRepo((home) => {
      const configPath = path.join(home, ".codex", "config.toml");
      mkdirSync(path.dirname(configPath), { recursive: true });
      const original = [
        "[features]",
        "default_mode_request_user_input = true",
        "js_repl = true",
        "",
      ].join("\n");
      writeFileSync(configPath, original);
      writeGlobalManifest(home, [{
        path: configPath,
        category: CATEGORIES.C,
        source: "sync-global-meta-theory",
        purpose: "codex-global-config-choice-surface-and-app-native-controls",
        kind: "settings-merge",
        mergedHookCommands: [
          "default_mode_request_user_input",
          "js_repl",
          "notify",
          "windows.sandbox",
          "marketplaces.openai-bundled",
          "plugins.browser@openai-bundled",
          "plugins.chrome@openai-bundled",
          "plugins.computer-use@openai-bundled",
        ],
        installedAt: new Date().toISOString(),
      }]);

      const result = runUninstall(home, ["--scope=global", "--yes"]);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /no_exact_managed_fragments_recorded/iu,
      );
      assert.equal(readFileSync(configPath, "utf8"), original);
    });
  });
});

describe("uninstall / MCP fragment transaction", () => {
  const serverName = "managed-runtime";
  const managedDefinition = {
    type: "stdio",
    command: "meta-kim",
    args: ["mcp", "serve"],
    env: {},
  };

  function fixtureConfig() {
    return {
      auth: { provider: "user-owned" },
      env: { USER_SETTING: "keep" },
      mcpServers: {
        [serverName]: managedDefinition,
        userServer: { type: "http", url: "https://example.invalid/mcp" },
      },
    };
  }

  function actionFor(target) {
    return {
      path: target,
      serverName,
      fingerprint: mcpDefinitionFingerprint(managedDefinition),
    };
  }

  test("removes only the exact managed fragment and backs up the same original bytes", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "claude-user.json");
      const original = Buffer.from(`${JSON.stringify(fixtureConfig(), null, 2)}\n`, "utf8");
      writeFileSync(target, original);

      const result = removeManagedMcpFragmentFromFile(actionFor(target));
      assert.equal(result.success, true);
      assert.deepEqual(readFileSync(result.backupPath), original);

      const updated = JSON.parse(readFileSync(target, "utf8"));
      assert.equal(updated.mcpServers[serverName], undefined);
      assert.deepEqual(updated.mcpServers.userServer, fixtureConfig().mcpServers.userServer);
      assert.deepEqual(updated.auth, fixtureConfig().auth);
      assert.deepEqual(updated.env, fixtureConfig().env);
    });
  });

  test("fails closed when the target changes between snapshot and commit", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "claude-user.json");
      const original = Buffer.from(`${JSON.stringify(fixtureConfig(), null, 2)}\n`, "utf8");
      const concurrent = Buffer.from(`${JSON.stringify({ ...fixtureConfig(), note: "concurrent" }, null, 2)}\n`, "utf8");
      writeFileSync(target, original);

      const result = removeManagedMcpFragmentFromFile(actionFor(target), {
        beforeCommit: () => writeFileSync(target, concurrent),
      });

      assert.equal(result.success, false);
      assert.equal(result.reason, "concurrent_change");
      assert.deepEqual(readFileSync(target), concurrent);
      assert.deepEqual(readFileSync(result.backupPath), original);
    });
  });

  test("a staged replacement write failure leaves the target untouched", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "claude-user.json");
      const original = Buffer.from(`${JSON.stringify(fixtureConfig(), null, 2)}\n`, "utf8");
      writeFileSync(target, original);

      const result = removeManagedMcpFragmentFromFile(actionFor(target), {
        stageWriter: (request) => {
          if (request.purpose === "replacement") throw new Error("simulated write failure");
          writeDurableStagedFile(request);
        },
      });

      assert.equal(result.success, false);
      assert.match(result.reason, /^atomic_write_failed:/u);
      assert.deepEqual(readFileSync(target), original);
      assert.deepEqual(readFileSync(result.backupPath), original);
    });
  });

  test("a symlinked MCP config is rejected without replacing the link", () => {
    withTmpRepo((repo) => {
      const realTarget = path.join(repo, "real-config.json");
      const linkTarget = path.join(repo, "linked-config.json");
      const original = Buffer.from(`${JSON.stringify(fixtureConfig(), null, 2)}\n`, "utf8");
      writeFileSync(realTarget, original);
      let retainedTarget = realTarget;
      try {
        symlinkSync(realTarget, linkTarget, "file");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
          const realDirectory = path.join(repo, "real-config-directory");
          mkdirSync(realDirectory, { recursive: true });
          retainedTarget = path.join(realDirectory, "config.json");
          writeFileSync(retainedTarget, original);
          symlinkSync(realDirectory, linkTarget, "junction");
        } else {
          throw error;
        }
      }

      const result = removeManagedMcpFragmentFromFile(actionFor(linkTarget));
      assert.equal(result.success, false);
      assert.equal(result.reason, "unsafe_config_file_type");
      assert.equal(lstatSync(linkTarget).isSymbolicLink(), true);
      assert.deepEqual(readFileSync(retainedTarget), original);
    });
  });

  test("the generic snapshot rewrite rejects stale original bytes", () => {
    withTmpRepo((repo) => {
      const target = path.join(repo, "config.json");
      const original = Buffer.from("old\n", "utf8");
      writeFileSync(target, "new\n");
      const result = atomicRewriteFileFromSnapshot(target, original, Buffer.from("replacement\n"));
      assert.equal(result.success, false);
      assert.equal(result.reason, "concurrent_change");
      assert.equal(readFileSync(target, "utf8"), "new\n");
    });
  });
});

describe("uninstall / durable runtime bundle ownership", () => {
  test("recordDir captures a closed-set fingerprint for every managed directory", () => {
    withTmpRepo((repo) => {
      const { bundle } = createManagedBundle(repo);
      const recorder = openRecorder({
        scope: "project",
        repoRoot: repo,
        metaKimVersion: "test",
      });
      recorder.recordDir(bundle, {
        source: "sync-global-meta-theory",
        purpose: "claude-global-hooks-dir",
        category: CATEGORIES.B,
      });
      const entry = recorder.snapshot().entries.find((candidate) => candidate.path === bundle);
      const closure = directoryClosureSync(bundle);
      assert.equal(entry.directoryClosureSha256, closure.sha256);
      assert.equal(entry.directoryClosureEntryCount, closure.entryCount);
    });
  });

  test("removes an exact bundle whose three proofs and full closure match", () => {
    withTmpRepo((repo) => {
      const { bundle, action } = createManagedBundle(repo);
      const result = removeExactManagedRuntimeBundle(action);
      assert.equal(result.success, true);
      assert.equal(existsSync(bundle), false);
    });
  });

  test("preserves the bundle when an unknown file appears", () => {
    withTmpRepo((repo) => {
      const { bundle, action } = createManagedBundle(repo);
      writeFileSync(path.join(bundle, "user-note.txt"), "keep me\n");
      const result = removeExactManagedRuntimeBundle(action);
      assert.equal(result.success, false);
      assert.equal(result.preserved, true);
      assert.equal(result.reason, "bundle_closure_drift");
      assert.equal(existsSync(path.join(bundle, "user-note.txt")), true);
    });
  });

  test("preserves the bundle when any required proof drifts", () => {
    withTmpRepo((repo) => {
      const { bundle, proofByRole, action } = createManagedBundle(repo);
      writeFileSync(proofByRole.cli, "user changed cli\n");
      const result = removeExactManagedRuntimeBundle(action);
      assert.equal(result.success, false);
      assert.equal(result.reason, "bundle_proof_drift");
      assert.equal(existsSync(bundle), true);
    });
  });

  test("validates and accepts an additional exact descendant proof", () => {
    withTmpRepo((repo) => {
      const { bundle, action } = createManagedBundle(repo);
      const extraPath = path.join(bundle, ".meta-kim-candidate.json");
      writeFileSync(extraPath, "candidate\n");
      const extraBytes = readFileSync(extraPath);
      const closure = directoryClosureSync(bundle);
      action.closureSha256 = closure.sha256;
      action.closureEntryCount = closure.entryCount;
      action.proofFiles.push({
        path: extraPath,
        role: "candidate-lock",
        kind: "file",
        source: action.source,
        size: extraBytes.length,
        sha256: sha256(extraBytes),
      });
      const result = removeExactManagedRuntimeBundle(action);
      assert.equal(result.success, true);
      assert.equal(existsSync(bundle), false);
    });
  });

  test("does not silently discard an extra proof with invalid source or ancestry", () => {
    withTmpRepo((repo) => {
      const { bundle, action } = createManagedBundle(repo);
      action.proofFiles.push({
        ...action.proofFiles[0],
        role: "candidate-lock",
        source: "other-source",
      });
      const result = removeExactManagedRuntimeBundle(action);
      assert.equal(result.success, false);
      assert.equal(result.reason, "invalid_bundle_proof");
      assert.equal(existsSync(bundle), true);
    });
  });

  test("keeps a drifted quarantine when recursive deletion fails mid-flight", () => {
    withTmpRepo((repo) => {
      const { bundle, action } = createManagedBundle(repo);
      const result = removeExactManagedRuntimeBundle(action, {
        removeDirectory: (quarantinePath) => {
          writeFileSync(path.join(quarantinePath, "partial-delete-marker.txt"), "drift\n");
          throw new Error("simulated recursive delete failure");
        },
      });
      assert.equal(result.success, false);
      assert.equal(result.preserved, false);
      assert.match(result.reason, /^rollback_incomplete:/u);
      assert.equal(existsSync(bundle), false);
      assert.ok(result.quarantinePath);
      assert.equal(existsSync(path.join(result.quarantinePath, "partial-delete-marker.txt")), true);
    });
  });

  test("orders exact MCP fragment removal before runtime bundle removal", () => {
    const ordered = orderUninstallActions([
      { kind: "remove", path: "other" },
      { kind: "remove-bundle", path: "bundle" },
      { kind: "strip-mcp", path: "config" },
    ]);
    assert.deepEqual(ordered.map((action) => action.kind), [
      "strip-mcp",
      "remove-bundle",
      "remove",
    ]);
  });

  test("orders all projection references before the primary bundle and the primary bundle last", () => {
    const ordered = orderUninstallActions([
      {
        kind: "remove-bundle",
        purpose: PRIMARY_PROJECTION_BUNDLE_PURPOSE,
        path: "primary-bundle",
      },
      { kind: "remove", path: "unrelated" },
      {
        kind: "remove",
        path: "command",
        primaryProjectionReferenceCleanup: true,
      },
      {
        kind: "strip-settings",
        path: "hooks.json",
        primaryProjectionReferenceCleanup: true,
      },
      {
        kind: "remove-bundle",
        purpose: "claude-global-mcp-runtime-bundle",
        path: "mcp-bundle",
      },
    ]);
    assert.deepEqual(ordered.map((action) => action.path), [
      "command",
      "hooks.json",
      "mcp-bundle",
      "unrelated",
      "primary-bundle",
    ]);
  });

  test("removes an exact primary projection bundle with all four proof roles", () => {
    withTmpRepo((repo) => {
      const { digestDir, action } = createPrimaryProjectionBundle(repo);
      assert.deepEqual(
        action.proofFiles.map((proof) => proof.role).sort(),
        ["cli", "package-manifest", "receipt", "sync-script"],
      );
      const result = removeExactManagedRuntimeBundle(action);
      assert.equal(result.success, true);
      assert.equal(existsSync(digestDir), false);
    });
  });

  test("primary projection uninstall waits on the shared digest transaction lock", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "meta-kim-uninstall-lock-"));
    try {
      mkdirSync(path.join(repo, ".meta-kim"), { recursive: true });
      const bundle = createPrimaryProjectionBundle(repo);
      const layout = resolveGlobalProjectionPackageLayout({
        homeRoot: repo,
        packageName: "meta-kim",
        packageVersion: "2.0.22",
        packageTarballSha256: "a".repeat(64),
      });
      let releaseHolder;
      let holderEntered;
      const holderReady = new Promise((resolve) => { holderEntered = resolve; });
      const holder = withProjectionDigestLock(
        layout,
        async () => {
          holderEntered();
          await new Promise((resolve) => { releaseHolder = resolve; });
        },
        { homeRoot: repo },
      );
      await holderReady;

      let uninstallFinished = false;
      const uninstall = removeExactManagedRuntimeBundleWithLock(
        bundle.action,
        { homeRoot: repo },
      ).then((result) => {
        uninstallFinished = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(uninstallFinished, false);
      assert.equal(existsSync(bundle.digestDir), true);
      releaseHolder();
      await holder;
      const result = await uninstall;
      assert.equal(result.success, true);
      assert.equal(existsSync(bundle.digestDir), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("preserves a primary projection bundle when a user file changes its closure", () => {
    withTmpRepo((repo) => {
      const { digestDir, action } = createPrimaryProjectionBundle(repo);
      writeFileSync(path.join(digestDir, "user-owned-note.txt"), "preserve me\n");
      const result = removeExactManagedRuntimeBundle(action);
      assert.equal(result.success, false);
      assert.equal(result.preserved, true);
      assert.equal(result.reason, "projection_receipt_layout_drift");
      assert.equal(existsSync(path.join(digestDir, "user-owned-note.txt")), true);
    });
  });

  test("a forged receipt preserves a first-party sentinel even when manifest proofs are refreshed", () => {
    withTmpRepo((repo) => {
      const bundle = createPrimaryProjectionBundle(repo);
      const sentinel = path.join(
        bundle.digestDir,
        "bundle",
        "node_modules",
        "meta-kim",
        "user-sentinel.txt",
      );
      writeFileSync(sentinel, "PRESERVE SENTINEL\n", "utf8");
      const receipt = JSON.parse(readFileSync(bundle.proofByRole.receipt, "utf8"));
      receipt.schemaVersion = "forged-receipt-schema";
      receipt.bundleClosure = directoryClosureSync(path.join(bundle.digestDir, "bundle"));
      writeFileSync(
        bundle.proofByRole.receipt,
        `${JSON.stringify(receipt, null, 2)}\n`,
        "utf8",
      );
      refreshPrimaryBundleAction(bundle);

      const result = removeExactManagedRuntimeBundle(bundle.action);
      assert.equal(result.success, false);
      assert.equal(result.preserved, true);
      assert.equal(result.reason, "projection_receipt_schema_mismatch");
      assert.equal(readFileSync(sentinel, "utf8"), "PRESERVE SENTINEL\n");
    });
  });

  test("receipt first-party drift preserves a sentinel despite refreshed bundle and manifest closures", () => {
    withTmpRepo((repo) => {
      const bundle = createPrimaryProjectionBundle(repo);
      const sentinel = path.join(
        bundle.digestDir,
        "bundle",
        "node_modules",
        "meta-kim",
        "user-sentinel.txt",
      );
      writeFileSync(sentinel, "PRESERVE SENTINEL\n", "utf8");
      const receipt = JSON.parse(readFileSync(bundle.proofByRole.receipt, "utf8"));
      receipt.bundleClosure = directoryClosureSync(path.join(bundle.digestDir, "bundle"));
      writeFileSync(
        bundle.proofByRole.receipt,
        `${JSON.stringify(receipt, null, 2)}\n`,
        "utf8",
      );
      refreshPrimaryBundleAction(bundle);

      const result = removeExactManagedRuntimeBundle(bundle.action);
      assert.equal(result.success, false);
      assert.equal(result.preserved, true);
      assert.equal(result.reason, "projection_receipt_first_party_drift");
      assert.equal(readFileSync(sentinel, "utf8"), "PRESERVE SENTINEL\n");
    });
  });

  test("rejects self-authored primary projection bundle source and purpose identities", () => {
    withTmpRepo((repo) => {
      const sourceForged = createPrimaryProjectionBundle(repo);
      sourceForged.action.source = "user-self-authored";
      sourceForged.action.proofFiles = sourceForged.action.proofFiles.map((proof) => ({
        ...proof,
        source: "user-self-authored",
      }));
      const sourceResult = removeExactManagedRuntimeBundle(sourceForged.action);
      assert.equal(sourceResult.success, false);
      assert.equal(sourceResult.preserved, true);
      assert.equal(existsSync(sourceForged.digestDir), true);

      rmSync(sourceForged.digestDir, { recursive: true, force: true });
      const purposeForged = createPrimaryProjectionBundle(repo);
      purposeForged.action.purpose = "forged-runtime-bundle";
      const purposeResult = removeExactManagedRuntimeBundle(purposeForged.action);
      assert.equal(purposeResult.success, false);
      assert.equal(purposeResult.preserved, true);
      assert.equal(existsSync(purposeForged.digestDir), true);
    });
  });

  test("preserves a primary projection bundle reached through a linked ancestor", () => {
    withTmpRepo((repo) => {
      const physicalStore = path.join(repo, "physical-projection-store");
      const linkedStore = path.join(repo, "linked-projection-store");
      mkdirSync(physicalStore, { recursive: true });
      symlinkSync(
        physicalStore,
        linkedStore,
        process.platform === "win32" ? "junction" : "dir",
      );
      const { digestDir, action } = createPrimaryProjectionBundle(repo, {
        storeRoot: linkedStore,
      });
      const physicalDigest = path.join(
        physicalStore,
        "meta-kim",
        "2.0.22",
        "a".repeat(64),
      );
      const result = removeExactManagedRuntimeBundle(action);
      assert.equal(result.success, false);
      assert.equal(result.preserved, true);
      assert.equal(existsSync(digestDir), true);
      assert.equal(existsSync(physicalDigest), true);
    });
  });
});
