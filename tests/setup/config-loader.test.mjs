import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MetaKimConfigError,
  loadMetaKimConfig,
  normalizeRepositorySource,
} from "../../scripts/meta-kim-config-loader.mjs";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tempRoots = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

function fixtureRoot({ skills, skillsRaw, distribution, sync } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-config-"));
  tempRoots.push(root);
  const configDir = path.join(root, "config");
  const contractsDir = path.join(configDir, "contracts");
  mkdirSync(contractsDir, { recursive: true });
  cpSync(
    path.join(repoRoot, "config", "contracts", "skills-manifest.schema.json"),
    path.join(contractsDir, "skills-manifest.schema.json"),
  );
  cpSync(
    path.join(repoRoot, "config", "contracts", "distribution.schema.json"),
    path.join(contractsDir, "distribution.schema.json"),
  );
  writeFileSync(
    path.join(configDir, "distribution.json"),
    JSON.stringify(
      distribution ??
        JSON.parse(readFileSync(path.join(repoRoot, "config", "distribution.json"), "utf8")),
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(configDir, "sync.json"),
    JSON.stringify(
      sync ?? {
        schemaVersion: 1,
        supportedTargets: ["claude", "codex", "openclaw", "cursor"],
      },
      null,
      2,
    ),
  );
  if (skillsRaw !== undefined) {
    writeFileSync(path.join(configDir, "skills.json"), skillsRaw);
  } else if (skills !== null) {
    writeFileSync(
      path.join(configDir, "skills.json"),
      JSON.stringify(
        skills ?? {
          $schema: "./contracts/skills-manifest.schema.json",
          schemaVersion: 1,
          skillOwner: "example",
          skills: [{ id: "sample", repo: "${skillOwner}/sample" }],
        },
        null,
        2,
      ),
    );
  }
  return root;
}

function isConfigError(code) {
  return (error) => error instanceof MetaKimConfigError && error.code === code;
}

describe("shared Meta_Kim configuration loader", () => {
  test("loads current config and derives repositories, marketplaces, and distribution values", () => {
    const config = loadMetaKimConfig({ repoRoot });
    const superpowers = config.skills.skills.find((skill) => skill.id === "superpowers");
    assert.equal(superpowers.repository.cloneUrl, "https://github.com/obra/superpowers.git");
    assert.equal(
      superpowers.marketplace.repository.cloneUrl,
      "https://github.com/obra/superpowers-marketplace.git",
    );
    assert.equal(superpowers.versionSource.repository.fullName, "obra/superpowers");
    assert.equal(config.distribution.project.npxSpec, "github:KimYx0207/Meta_Kim");
  });

  test("omitted targets expand from the authoritative sync supportedTargets", () => {
    const root = fixtureRoot();
    const config = loadMetaKimConfig({ repoRoot: root });
    assert.deepEqual(config.skills.skills[0].targets, [
      "claude",
      "codex",
      "openclaw",
      "cursor",
    ]);
  });

  test("missing, malformed, schema-invalid, and semantic-invalid config fail closed", () => {
    assert.throws(
      () => loadMetaKimConfig({ repoRoot: fixtureRoot({ skills: null }) }),
      isConfigError("CONFIG_MISSING"),
    );
    assert.throws(
      () => loadMetaKimConfig({ repoRoot: fixtureRoot({ skillsRaw: "{" }) }),
      isConfigError("CONFIG_JSON_INVALID"),
    );
    assert.throws(
      () =>
        loadMetaKimConfig({
          repoRoot: fixtureRoot({
            skills: {
              $schema: "./contracts/skills-manifest.schema.json",
              schemaVersion: 1,
              skillOwner: "example",
              skills: [{ id: "missing-repo" }],
            },
          }),
        }),
      isConfigError("CONFIG_SCHEMA_INVALID"),
    );
    assert.throws(
      () =>
        loadMetaKimConfig({
          repoRoot: fixtureRoot({
            skills: {
              $schema: "./contracts/skills-manifest.schema.json",
              schemaVersion: 1,
              skillOwner: "example",
              skills: [
                { id: "duplicate", repo: "example/one" },
                { id: "duplicate", repo: "example/two" },
              ],
            },
          }),
        }),
      isConfigError("CONFIG_SEMANTIC_INVALID"),
    );
  });

  test("normalizes owner/name, HTTPS, and trusted SSH without accepting unsafe hosts", () => {
    const options = {
      defaultHttpsBase: "https://github.com",
      trustedHosts: ["github.com"],
    };
    assert.equal(
      normalizeRepositorySource("owner/repo", options).cloneUrl,
      "https://github.com/owner/repo.git",
    );
    assert.equal(
      normalizeRepositorySource("https://github.com/owner/repo", options).cloneUrl,
      "https://github.com/owner/repo.git",
    );
    assert.equal(
      normalizeRepositorySource("git@github.com:owner/repo.git", options).cloneUrl,
      "git@github.com:owner/repo.git",
    );
    assert.equal(
      normalizeRepositorySource("ssh://git@github.com/owner/repo.git", options).cloneUrl,
      "ssh://git@github.com/owner/repo.git",
    );
    assert.throws(
      () => normalizeRepositorySource("git@evil.example:owner/repo.git", options),
      isConfigError("CONFIG_SEMANTIC_INVALID"),
    );
    assert.throws(
      () => normalizeRepositorySource("http://github.com/owner/repo", options),
      isConfigError("CONFIG_SEMANTIC_INVALID"),
    );
  });

  test("setup and installer preflight config before any installer filesystem mutation", () => {
    const setupSource = readFileSync(path.join(repoRoot, "setup.mjs"), "utf8");
    const installerSource = readFileSync(
      path.join(repoRoot, "scripts", "install-global-skills-all-runtimes.mjs"),
      "utf8",
    );
    const setupPreflight = setupSource.indexOf("loadMetaKimConfig({ repoRoot: PROJECT_DIR })");
    const setupMain = setupSource.indexOf("async function main()");
    const installerPreflight = installerSource.indexOf("const installerConfig = loadInstallerConfig()");
    const installerTee = installerSource.indexOf("setupTeeStdout(parseLogFileArg(cliArgs))");
    const installerCleanup = installerSource.search(/\bawait\s+cleanupLegacyGlobalArtifacts\s*\(/u);
    for (const [anchor, index] of Object.entries({
      setupPreflight,
      setupMain,
      installerPreflight,
      installerTee,
      installerCleanup,
    })) {
      assert.ok(index >= 0, `${anchor} must exist before checking preflight order`);
    }
    assert.ok(setupPreflight < setupMain);
    assert.ok(installerPreflight < installerTee);
    assert.ok(installerTee < installerCleanup);
    assert.doesNotMatch(installerSource, /pluginRepoMap|\$\{bareName\}\/\$\{bareName\}/);
  });
});
