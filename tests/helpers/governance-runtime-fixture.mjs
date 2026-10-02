import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildIsolatedTestEnvironment } from "../../scripts/run-local-verification.mjs";

const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));

function write(root, relative, content) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/**
 * Run the real repository-anchored CLIs against disposable source and HOME
 * trees. Never reuse the developer's projections, inventory, graph, or host
 * evidence. Providers below are discovery fixtures, not installed production
 * capabilities and not evidence that a host has invoked a tool or agent.
 */
export function createGovernanceRuntimeFixture(t, { graph = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-governance-fixture-"));
  const repoRoot = path.join(root, "repo");
  const home = path.join(root, "home");
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  t?.after(cleanup);
  try {
    mkdirSync(repoRoot);
    mkdirSync(home);
    for (const dir of ["tmp", "appdata", "localappdata", "config", "cache", "data", "state", "npm-cache"]) {
      mkdirSync(path.join(home, dir));
    }
    mkdirSync(path.join(repoRoot, "tmp"));
    // Copy only source inputs. Scripts resolve their repository from import.meta
    // rather than cwd, so a fresh HOME alone would still mutate the real checkout.
    for (const entry of [
      "canonical", "config", "scripts", "src", "docs", "tests/fixtures", "tests/meta-theory/scenarios",
      "package.json", "setup.mjs", "AGENTS.md", "CLAUDE.md", "LICENSE",
      ...readdirSync(sourceRoot).filter((name) => /^README(?:\.[\w-]+)?\.md$/u.test(name)),
    ]) {
      cpSync(path.join(sourceRoot, entry), path.join(repoRoot, entry), { recursive: true });
    }
    // A local marker prevents a sandbox's ancestor .git from becoming authority.
    mkdirSync(path.join(repoRoot, ".git"));
    const env = buildIsolatedTestEnvironment(home);
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      META_KIM_RUNTIME_FAMILY: "shared",
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
    });
    const run = (args, options = {}) => spawnSync(process.execPath, args, {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    });
    const prepare = (args) => {
      const result = run(args);
      assert.equal(result.status, 0, `fixture preparation ${args.join(" ")}: ${result.stderr || result.stdout}`);
    };

    prepare(["scripts/sync-runtimes.mjs", "--scope", "project", "--targets", "claude,codex,cursor,openclaw"]);

    // The IDs model specific discoverable role contracts used by the routing
    // scenarios. Their content makes fixture provenance and invocation limits
    // explicit; no provider's verification or host acceptance is manufactured.
    for (const id of ["worker", "analysis", "frontend", "backend", "test", "review"]) {
      const description = `Governance test fixture: bounded ${id} role contract`;
      const instructions = `Test fixture for ${id} discovery only. Read the assigned scope and return evidence. No external writes. Discovery does not prove invocation.`;
      write(home, `.codex/agents/${id}.toml`, `name = "${id}"\ndescription = "${description}"\ndeveloper_instructions = "${instructions}"\n`);
      write(home, `.claude/agents/${id}.md`, `---\nname: ${id}\ndescription: ${description}\ntools: Read\n---\n\n${instructions}\n`);
    }
    for (const runtime of [".codex", ".claude"]) {
      for (const id of [
        "findskill", "meta-skill-creator", "create-agent", "agent-teams-playbook",
        "get-context", "ideate", "design-review", "design-html", "agent-browser",
        "e2e-testing",
      ]) {
        write(home, `${runtime}/skills/${id}/SKILL.md`, `---\nname: ${id}\ndescription: Governance test fixture for ${id} capability discovery\n---\n\n# ${id} test fixture\n\nDiscovery-only test input. Does not establish host execution, external access, or verification.\n`);
      }
    }
    write(home, ".claude/plugins/repos/governance-test-plugin/package.json", JSON.stringify({
      name: "governance-test-plugin", version: "0.0.0", private: true,
      description: "Disposable plugin discovery fixture; no executable entrypoint",
    }));
    prepare(["scripts/discover-global-capabilities.mjs", "--runtime-inventory-only"]);

    if (graph) {
      write(repoRoot, "graphify-out/GRAPH_REPORT.md", "# Governance test graph fixture\n\nDisposable navigation evidence for canonical/agents/meta-warden.md and config/contracts/core-loop-contract.json. This is not a generated production graph or freshness attestation.\n");
      write(repoRoot, "graphify-out/graph.json", JSON.stringify({
        fixture: "governance-runtime-fixture",
        nodes: [{ id: "core-loop", file: "config/contracts/core-loop-contract.json" }],
        edges: [],
      }));
    }
    return { root, repoRoot, home, env, run, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * For tests that import the real runner in-process. Use only in a serial test
 * scope: cwd and environment are process-global. Import from this copied tree
 * after entering the scope so module-level repository/HOME paths are isolated.
 * Passing null leaves lifecycle registration to a suite's before/after hooks.
 */
export function createGovernanceRuntimeFixtureScope(t, options = {}) {
  const cwd = process.cwd();
  const originalEnv = { ...process.env };
  const fixture = createGovernanceRuntimeFixture(null, options);
  let active = true;
  const replaceEnvironment = (environment) => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, environment);
  };
  const cleanup = () => {
    if (!active) return;
    active = false;
    process.chdir(cwd);
    replaceEnvironment(originalEnv);
    fixture.cleanup();
  };
  t?.after(cleanup);
  try {
    process.chdir(fixture.repoRoot);
    replaceEnvironment(fixture.env);
  } catch (error) {
    cleanup();
    throw error;
  }
  return {
    ...fixture,
    cleanup,
    import: (relativeModule) => import(pathToFileURL(path.join(fixture.repoRoot, relativeModule)).href),
  };
}
