import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { addDshResource, buildDshProjection, manageDsh, readDshServicePackage } from "../../scripts/dsh-profile-package.mjs";
import { sha256Buffer } from "../../scripts/safe-managed-file-operations.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function resourceParts(files, indexPath) {
  const index = JSON.parse(files.get(indexPath));
  const dir = path.posix.dirname(indexPath);
  const parts = index.parts ?? index.pages.flatMap((page) => {
    const bytes = files.get(`${dir}/${page.path}`); assert.equal(sha256Buffer(bytes), page.sha256);
    return JSON.parse(bytes).parts;
  });
  return parts.map((part) => ({ ...part, file: `${dir}/${part.path}` }));
}
const fixture = (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "meta-dsh-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const homeRoot = path.join(temp, "home");
  const sourceRoot = path.join(temp, "source");
  fs.mkdirSync(homeRoot); fs.mkdirSync(sourceRoot);
  for (const entry of ["canonical/agents", "canonical/skills/meta-theory", "canonical/runtime-assets/dsh", "config/contracts",
    "config/capability-index", "config/runtime-capability-matrix.json", "config/os-compatibility-matrix.json",
    "config/runtime-compatibility-catalog.json", "config/skills.json", "config/sync.json",
    "config/governance/decision-pattern-catalog.json", "package.json", "LICENSE", "NOTICE"]) {
    if (!fs.existsSync(path.join(ROOT, entry))) continue;
    fs.mkdirSync(path.dirname(path.join(sourceRoot, entry)), { recursive: true });
    fs.cpSync(path.join(ROOT, entry), path.join(sourceRoot, entry), { recursive: true });
  }
  return { temp, homeRoot, sourceRoot, mcp: false };
};

test("native projection keeps the nine governance methods lossless and entry bodies bounded", () => {
  const projection = buildDshProjection();
  const entries = [...projection.files.keys()].filter((file) => /^skills\/[^/]+\/SKILL\.md$/u.test(file));
  assert.equal(entries.length, 10);
  for (const entry of entries) {
    const body = projection.files.get(entry).toString("utf8").replace(/^---\n[\s\S]*?\n---\n/u, "");
    assert.ok(body.length <= 6000);
    const base = path.posix.dirname(entry);
    const method = JSON.parse(projection.files.get(`${base}/method.json`));
    const original = path.posix.normalize(`${base}/${method.original}`);
    const parts = resourceParts(projection.files, path.posix.normalize(`${base}/${method.partsIndex}`)).map((part) => {
      const bytes = projection.files.get(part.file);
      assert.equal(sha256Buffer(bytes), part.sha256);
      assert.ok(bytes.toString("utf8").length <= 6000);
      return bytes;
    });
    assert.deepEqual(Buffer.concat(parts), projection.files.get(original));
    assert.equal(sha256Buffer(Buffer.concat(parts)), method.sourceSha256);
  }
  assert.equal(projection.contract.nativeCustomAgentPresets, false);
  assert.equal(projection.contract.nativeHookEnforcement, false);
});

test("projected methods retain their referenced runtime and discovery facts without copying local configuration", async (t) => {
  const opts = fixture(t);
  const sourcePrefix = "skills/meta-theory/source/";
  // These files must remain private even though they are adjacent to the
  // reviewed source configuration. No configuration-directory wildcard is used.
  for (const relative of ["config/local-credentials.json", "config/capability-index/private-local.json", ".meta-kim/local.overrides.json"]) {
    const file = path.join(opts.sourceRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"privateSentinel":"must-stay-local"}\n');
  }
  const projections = [
    buildDshProjection({ sourceRoot: opts.sourceRoot }),
    buildDshProjection({ sourceRoot: opts.sourceRoot, executionRoot: path.join(opts.temp, "immutable-package") }),
  ];
  const references = new Set();
  for (const [file, bytes] of projections[0].files) {
    if (!/^skills\/meta-theory\/source\/canonical\/(?:agents\/|skills\/meta-theory\/).*\.md$/u.test(file)) continue;
    for (const [relative] of bytes.toString("utf8").matchAll(/(?:config|canonical\/runtime-assets\/dsh)\/[A-Za-z0-9_./-]+\.(?:json|md)/gu)) {
      // Examples of a future project artifact are not source dependencies.
      // Resolve against the real repository, not the fixture's copy allowlist:
      // a newly referenced source must fail here if the fixture omitted it.
      if (fs.existsSync(path.join(ROOT, relative))) {
        assert.ok(fs.existsSync(path.join(opts.sourceRoot, relative)), `Referenced source missing from fixture: ${relative}`);
        references.add(relative);
      }
    }
  }
  assert.ok(references.has("config/runtime-capability-matrix.json"));
  assert.ok(references.has("config/capability-index/dependency-project-registry.json"));
  assert.ok(references.has("canonical/runtime-assets/dsh/host-contract.json"));
  for (const projection of projections) {
    for (const relative of references) {
      const target = `${sourcePrefix}${relative}`;
      const original = fs.readFileSync(path.join(opts.sourceRoot, relative));
      assert.deepEqual(projection.files.get(target), original, `Missing documented source: ${relative}`);
      const indexPath = `${target}.dsh-parts/index.json`;
      const parts = resourceParts(projection.files, indexPath).map(part => {
        const bytes = projection.files.get(part.file);
        assert.equal(sha256Buffer(bytes), part.sha256);
        return bytes;
      });
      assert.deepEqual(Buffer.concat(parts), original, `Incomplete readable source: ${relative}`);
      assert.equal(JSON.parse(projection.files.get(indexPath)).sha256, sha256Buffer(original));
    }
    for (const [file, bytes] of projection.files) assert.ok(!bytes.includes(Buffer.from("must-stay-local")), `Private file projected: ${file}`);
  }
  const installed = await manageDsh("install", opts);
  assert.equal(installed.ok, true);
  assert.equal(installed.mcpConfigured, false);
  const sourceRoot = path.join(installed.runtimeRoot, sourcePrefix);
  for (const relative of references) assert.deepEqual(fs.readFileSync(path.join(sourceRoot, relative)), fs.readFileSync(path.join(opts.sourceRoot, relative)));
  assert.equal((await manageDsh("check", opts)).status, "verified_files");
});

test("bounded parts retain Unicode and final content even without line breaks", () => {
  const files = new Map();
  const bytes = Buffer.from("x".repeat(5999) + "😀" + "界".repeat(9000) + "TAIL");
  addDshResource(files, "method.md", bytes);
  assert.deepEqual(Buffer.concat(resourceParts(files, "method.md.dsh-parts/index.json").map((part) => files.get(part.file))), bytes);
});

test("executable source views retain final rejection checks without changing runnable bytes", () => {
  const files = new Map();
  const source = Buffer.from(`${"// Checked source context\n".repeat(700)}throw new Error('reject incomplete acceptance');\n`);
  addDshResource(files, "verify.mjs", source);
  const parts = resourceParts(files, "verify.mjs.dsh-parts/index.json");
  assert.ok(parts.length > 1);
  assert.deepEqual(files.get("verify.mjs"), source);
  assert.deepEqual(Buffer.concat(parts.map((part) => files.get(part.file))), source);
  assert.match(files.get(parts.at(-1).file).toString("utf8"), /reject incomplete acceptance/u);
});

test("large JSON contracts retain final rules through paged, line-bounded readable parts", () => {
  const files = new Map();
  const bytes = Buffer.from(JSON.stringify({ knowledge: "界😀".repeat(30000), outputChecks: ["verify the final acceptance rule"] }));
  addDshResource(files, "contract.json", bytes);
  const parts = resourceParts(files, "contract.json.dsh-parts/index.json");
  assert.ok(JSON.parse(files.get("contract.json.dsh-parts/index.json")).pages.length > 1);
  for (const part of parts) {
    const text = files.get(part.file).toString("utf8");
    assert.ok(text.length <= 6000);
    assert.ok(text.split("\n").every((line) => line.length <= 1500));
    assert.ok(text.split("\n").length <= 121);
  }
  const reconstructed = Buffer.concat(parts.map((part) => files.get(part.file)));
  assert.deepEqual(reconstructed, bytes);
  assert.deepEqual(JSON.parse(reconstructed).outputChecks, ["verify the final acceptance rule"]);
  for (const [file, content] of files) if (/\/index(?:-\d+)?\.json$/u.test(file)) assert.ok(content.toString("utf8").length <= 5000);
});

test("install/update/check/uninstall use one ledger and preserve unrelated configuration", async (t) => {
  const opts = fixture(t);
  const original = path.join(opts.homeRoot, ".dsh/cordis.patch.yml");
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.writeFileSync(original, "# user configuration\n");
  const installed = await manageDsh("install", opts);
  assert.equal(installed.ok, true);
  assert.equal(installed.skillCount, 10);
  assert.deepEqual(installed.launch, ["dsh", "--profile", "meta-kim"]);
  const ledger = path.join(opts.homeRoot, ".meta-kim/install-manifest.json");
  assert.ok(JSON.parse(fs.readFileSync(ledger)).entries.every((entry) => entry.runtimeTarget === "deepseek-harness"));
  const before = fs.readFileSync(ledger);
  assert.equal((await manageDsh("update", opts)).status, "noop");
  assert.deepEqual(fs.readFileSync(ledger), before);
  const checked = await manageDsh("check", opts);
  assert.equal(checked.status, "verified_files");
  assert.equal(checked.mcpConfigured, false);
  assert.equal((await manageDsh("uninstall", opts)).ok, true);
  assert.equal(fs.existsSync(path.join(opts.homeRoot, ".dsh/skills/meta-theory/SKILL.md")), false);
  assert.equal(fs.readFileSync(original, "utf8"), "# user configuration\n");
  assert.equal((await manageDsh("check", opts)).status, "not_installed");
});

test("update preserves changed files and uninstall reports a partial result", async (t) => {
  const opts = fixture(t);
  await manageDsh("install", opts);
  const changed = path.join(opts.homeRoot, ".dsh/skills/meta-conductor/SKILL.md");
  fs.appendFileSync(changed, "\nUser local method\n");
  const bytes = fs.readFileSync(changed);
  const updated = await manageDsh("update", opts);
  assert.equal(updated.ok, false);
  assert.ok(updated.conflicts.some((item) => item.path === changed && item.reason === "user_modified"));
  assert.deepEqual(fs.readFileSync(changed), bytes);
  const removed = await manageDsh("uninstall", opts);
  assert.equal(removed.status, "partial");
  assert.deepEqual(fs.readFileSync(changed), bytes);
  assert.equal(fs.existsSync(path.join(opts.homeRoot, ".dsh/skills/meta-theory/SKILL.md")), false);
});

test("unowned identical bytes are not adopted and dry-run writes nothing", async (t) => {
  const opts = fixture(t);
  const first = await manageDsh("install", { ...opts, dryRun: true });
  assert.equal(first.status, "planned");
  assert.equal(fs.existsSync(path.join(opts.homeRoot, ".dsh")), false);
  const file = path.join(opts.homeRoot, ".dsh/skills/meta-theory/SKILL.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildDshProjection({ sourceRoot: opts.sourceRoot }).files.get("skills/meta-theory/SKILL.md"));
  assert.equal((await manageDsh("install", opts)).ok, false);
  assert.equal(fs.existsSync(path.join(opts.homeRoot, ".meta-kim/install-manifest.json")), false);
});

test("update removes stale owned resources and repairs missing owned resources", async (t) => {
  const opts = fixture(t);
  const source = path.join(opts.sourceRoot, "canonical/skills/meta-theory/references/obsolete-dsh-test.md");
  fs.writeFileSync(source, "obsolete reference\n");
  await manageDsh("install", opts);
  const installedSource = path.join(opts.homeRoot, ".dsh/skills/meta-theory/source/canonical/skills/meta-theory/references/obsolete-dsh-test.md");
  fs.unlinkSync(source);
  const missing = path.join(opts.homeRoot, ".dsh/skills/meta-prism/SKILL.md");
  fs.unlinkSync(missing);
  assert.equal((await manageDsh("check", opts)).status, "drift");
  assert.equal((await manageDsh("update", opts)).ok, true);
  assert.equal(fs.existsSync(installedSource), false);
  assert.equal(fs.existsSync(`${installedSource}.dsh-parts/index.json`), false);
  assert.equal(fs.existsSync(missing), true);
});

test("projection and ledger roll back together on a failed commit", async (t) => {
  const opts = fixture(t);
  await manageDsh("install", opts);
  const file = path.join(opts.homeRoot, ".dsh/skills/meta-theory/SKILL.md");
  const ledger = path.join(opts.homeRoot, ".meta-kim/install-manifest.json");
  const oldFile = fs.readFileSync(file); const oldLedger = fs.readFileSync(ledger);
  fs.appendFileSync(path.join(opts.sourceRoot, "canonical/runtime-assets/dsh/dispatcher.md"), "\nChanged loader\n");
  const previous = process.env.META_KIM_TEST_FAIL_MANAGED_COMMIT_AT;
  process.env.META_KIM_TEST_FAIL_MANAGED_COMMIT_AT = "2";
  try { assert.equal((await manageDsh("update", opts)).status, "rolled_back"); }
  finally { if (previous === undefined) delete process.env.META_KIM_TEST_FAIL_MANAGED_COMMIT_AT; else process.env.META_KIM_TEST_FAIL_MANAGED_COMMIT_AT = previous; }
  assert.deepEqual(fs.readFileSync(file), oldFile);
  assert.deepEqual(fs.readFileSync(ledger), oldLedger);
});

test("links in target ancestry or source resources fail closed", async (t) => {
  const opts = fixture(t);
  const elsewhere = path.join(opts.temp, "elsewhere"); fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(opts.homeRoot, ".dsh"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(manageDsh("install", opts), /unsafe|link/iu);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  fs.unlinkSync(path.join(opts.homeRoot, ".dsh"));
  fs.symlinkSync(path.join(opts.sourceRoot, "package.json"), path.join(opts.sourceRoot, "canonical/skills/meta-theory/leak.json"));
  assert.throws(() => buildDshProjection({ sourceRoot: opts.sourceRoot }), /link/iu);
});

test("project overlay keeps the real DSH_HOME active and custom global homes are supported", async (t) => {
  const opts = fixture(t);
  const projectRoot = path.join(opts.temp, "project"); fs.mkdirSync(projectRoot);
  const project = await manageDsh("install", { ...opts, scope: "project", projectRoot });
  assert.deepEqual(project.launchEnvironment, {});
  assert.deepEqual(project.launch, ["dsh", "--profile", "web", "--patch", path.join(projectRoot, ".dsh/meta-kim/cordis.patch.yml")]);
  const dshHome = path.join(opts.temp, "custom-dsh");
  const global = await manageDsh("install", { ...opts, dshHome });
  assert.equal(global.ok, true);
  assert.equal(global.launchEnvironment.DSH_HOME, dshHome);
  assert.equal(fs.existsSync(path.join(dshHome, "profiles/meta-kim/package.json")), true);
});

test("project installs refuse invisible nested roots and diagnose a later parent Git marker", async (t) => {
  const opts = fixture(t);
  const parent = path.join(opts.temp, "repo");
  const projectRoot = path.join(parent, "app");
  fs.mkdirSync(projectRoot, { recursive: true });
  const marker = path.join(parent, ".git");
  // Linked worktrees use a marker file; DSh treats it just like a directory.
  fs.writeFileSync(marker, "gitdir: /unread-placeholder\n");
  await assert.rejects(manageDsh("install", { ...opts, scope: "project", projectRoot }), /discovers project Skills from/u);
  assert.equal(fs.existsSync(path.join(projectRoot, ".dsh")), false);
  assert.equal(fs.existsSync(path.join(parent, ".dsh")), false, "The installer must not silently move the requested scope");
  fs.unlinkSync(marker);
  assert.equal((await manageDsh("install", { ...opts, scope: "project", projectRoot })).ok, true);
  const ledger = path.join(projectRoot, ".meta-kim/install-manifest.json");
  const before = fs.readFileSync(ledger);
  fs.mkdirSync(marker);
  const checked = await manageDsh("check", { ...opts, scope: "project", projectRoot });
  assert.equal(checked.status, "incomplete"); assert.equal(checked.ok, false);
  assert.equal(checked.hostProjectRoot, parent); assert.equal(checked.projectRootMatchesNativeDiscovery, false);
  assert.ok(checked.issues.some((issue) => issue.reason === "native_project_projection_root_mismatch"));
  await assert.rejects(manageDsh("update", { ...opts, scope: "project", projectRoot }), /No project files were changed/u);
  assert.deepEqual(fs.readFileSync(ledger), before);
  assert.equal((await manageDsh("uninstall", { ...opts, scope: "project", projectRoot })).ok, true, "Legacy misplaced files must remain removable");
  assert.equal(fs.existsSync(path.join(projectRoot, ".dsh/skills/meta-theory/SKILL.md")), false);
});

test("invalid ledgers and malformed Service bundles are preserved/refused", async (t) => {
  const opts = fixture(t);
  const ledger = path.join(opts.homeRoot, ".meta-kim/install-manifest.json");
  fs.mkdirSync(path.dirname(ledger), { recursive: true }); fs.writeFileSync(ledger, "invalid");
  await assert.rejects(manageDsh("install", opts), /manifest is invalid/u);
  assert.equal(fs.readFileSync(ledger, "utf8"), "invalid");
  const bundle = path.join(opts.temp, "bundle"); fs.mkdirSync(bundle);
  fs.writeFileSync(path.join(bundle, "dsh-package.json"), JSON.stringify({ schemaVersion: 1, kind: "kim-service-dsh-skills", files: [{ path: "../escape", size: 1, sha256: "0".repeat(64) }] }));
  assert.throws(() => readDshServicePackage(bundle), /Unsafe/u);
});

test("Service packages share lifecycle ownership and stay installed during a core-only update", async (t) => {
  const opts = fixture(t);
  const bundle = path.join(opts.temp, "service"); fs.mkdirSync(bundle);
  const makeBundle = (version) => {
    const files = new Map([
      ["skills/kim-service/SKILL.md", "---\nname: kim-service\ndescription: Service method catalogue\n---\nLoad the declared method.\n"],
      ["skills/kim-example/SKILL.md", `---\nname: kim-example\ndescription: Example method for lifecycle verification\n---\nMethod version ${version}.\n`],
    ]);
    const indexPath = "skills/kim-service/projection.json";
    files.set(indexPath, JSON.stringify({ schemaVersion: 1, expectedPaths: [...files.keys(), indexPath].sort() }));
    for (const [rel, bytes] of files) { const file = path.join(bundle, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
    fs.writeFileSync(path.join(bundle, "dsh-package.json"), JSON.stringify({ schemaVersion: 1, kind: "kim-service-dsh-skills", files: [...files].map(([file, bytes]) => ({ path: file, size: Buffer.byteLength(bytes), sha256: sha256Buffer(Buffer.from(bytes)) })) }));
  };
  makeBundle(1);
  assert.equal((await manageDsh("install", { ...opts, servicePackage: bundle })).skillCount, 12);
  const installed = path.join(opts.homeRoot, ".dsh/skills/kim-example/SKILL.md");
  const coreOnly = await manageDsh("update", opts);
  assert.equal(coreOnly.ok, true);
  assert.equal(coreOnly.skillCount, 12);
  assert.match(fs.readFileSync(installed, "utf8"), /version 1/u);
  makeBundle(2);
  assert.equal((await manageDsh("update", { ...opts, servicePackage: bundle })).ok, true);
  assert.match(fs.readFileSync(installed, "utf8"), /version 2/u);
  fs.appendFileSync(path.join(bundle, "skills/kim-example/SKILL.md"), "corrupt");
  await assert.rejects(manageDsh("update", { ...opts, servicePackage: bundle }), /integrity mismatch/u);
  assert.match(fs.readFileSync(installed, "utf8"), /version 2/u);
  const ledger = path.join(opts.homeRoot, ".meta-kim/install-manifest.json");
  const before = fs.readFileSync(ledger);
  const subset = JSON.parse(before);
  subset.entries = subset.entries.filter((entry) => entry.purpose !== "dsh-native-core");
  fs.writeFileSync(ledger, JSON.stringify(subset));
  const incomplete = await manageDsh("check", opts);
  assert.equal(incomplete.status, "incomplete"); assert.equal(incomplete.ok, false);
  assert.equal(incomplete.mcpConfigured, null, "Missing core ownership must not claim MCP is disabled");
  assert.ok(incomplete.issues.some((issue) => issue.reason === "incomplete_core_projection"));
  fs.writeFileSync(ledger, before);
  assert.equal((await manageDsh("uninstall", opts)).ok, true);
  assert.equal(fs.existsSync(installed), false);
});

test("check refuses a ledger subset that omits an expected core resource", async (t) => {
  const opts = fixture(t);
  await manageDsh("install", opts);
  const ledger = path.join(opts.homeRoot, ".meta-kim/install-manifest.json");
  const data = JSON.parse(fs.readFileSync(ledger));
  const omitted = path.join(opts.homeRoot, ".dsh/skills/meta-prism/SKILL.md");
  data.entries = data.entries.filter((entry) => entry.path !== omitted);
  fs.writeFileSync(ledger, JSON.stringify(data));
  const result = await manageDsh("check", opts);
  assert.equal(result.ok, false); assert.equal(result.status, "incomplete");
  assert.ok(result.issues.some((issue) => issue.path === omitted && issue.reason === "missing_projection_file_ownership"));
});

test("public CLI discovers DSh and rejects unknown flags without falling into setup", () => {
  const help = spawnSync(process.execPath, [path.join(ROOT, "bin/meta-kim.mjs"), "--help"], { encoding: "utf8" });
  assert.match(help.stdout, /meta-kim dsh install/u);
  const result = spawnSync(process.execPath, [path.join(ROOT, "bin/meta-kim.mjs"), "dsh", "install", "--not-a-real-option"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown DSh option/u);
  const target = spawnSync(process.execPath, [path.join(ROOT, "bin/meta-kim.mjs"), "install", "--targets", "dsh"], { encoding: "utf8" });
  assert.equal(target.status, 2);
  assert.match(target.stderr, /meta-kim dsh install --help/u);
});
