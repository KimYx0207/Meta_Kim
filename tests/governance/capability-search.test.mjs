import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = path.resolve("bin/meta-kim.mjs");
const modulePath = new URL("../../scripts/search-capabilities.mjs", import.meta.url);
const load = () => import(modulePath);
const now = "2026-10-26T08:00:00.000Z";
const record = (id, extra = {}) => ({ id, nativeIdentity: id, platformId: "codex", type: "agents", sourceRef: `~/.codex/agents/${id}.toml`,
  sourceKey: `codex:agents:${id}:personal`, sourceClass: "personal", sourceValid: true, routeEligible: true, selectedAsWinner: true,
  metadata: { name: id, description: "Review code security and correctness" }, ...extra });
const inventory = (rows) => ({ registryName: "global-capabilities", generatedAt: now, byCapabilityType: { agents: Object.fromEntries(rows.map((row, i) => [`provider-${i}:${row.id}`, row])) } });
async function fixture(t, value = inventory([record("audit-worker")])) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-kim-capability-search-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const inventoryPath = path.join(root, "global-capabilities.json");
  const canonicalPath = path.join(root, "canonical-capabilities.json");
  await writeFile(inventoryPath, JSON.stringify(value));
  await writeFile(canonicalPath, JSON.stringify({ registryName: "meta-kim-capabilities", generatedAt: now, byCapabilityType: {} }));
  return { root, inventoryPath, canonicalPath, now };
}

test("public capability search is bounded, deterministic and read-only from another cwd", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.inventoryPath, "utf8");
  const beforeStat = await stat(f.inventoryPath);
  const args = [cli, "capability", "search", "--query", "code security review", "--runtime", "codex", "--type", "agents", "--limit", "1", "--inventory", f.inventoryPath, "--canonical", f.canonicalPath, "--json"];
  const first = spawnSync(process.execPath, args, { cwd: f.root, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, "audit-worker");
  assert.equal(result.candidates[0].invocationState, "not_invoked");
  assert.equal(result.candidates[0].qualification, "not_assessed");
  assert.match(result.candidates[0].sourceRef, /^~\//u);
  assert.ok(result.candidates[0].matchedTerms.length > 0);
  assert.equal(await readFile(f.inventoryPath, "utf8"), before);
  assert.equal((await stat(f.inventoryPath)).mtimeMs, beforeStat.mtimeMs);
  const relative = [...args];
  relative[relative.indexOf("--inventory") + 1] = path.basename(f.inventoryPath);
  relative[relative.indexOf("--canonical") + 1] = path.basename(f.canonicalPath);
  const fromCaller = spawnSync(process.execPath, relative, { cwd: f.root, encoding: "utf8" });
  assert.equal(fromCaller.status, 0, fromCaller.stderr);
  assert.equal(JSON.parse(fromCaller.stdout).candidates[0].id, "audit-worker");
});

test("CLI help and invalid queries cannot fall through into install or execute providers", async (t) => {
  const f = await fixture(t);
  const help = spawnSync(process.execPath, [cli, "capability", "search", "--help"], { cwd: f.root, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /never scans, installs, selects or invokes/u);
  for (const args of [["--query", ""], ["--query", "code", "--limit", "100"], ["--query", "code", "--unknown"], ["--query", "code", "--query", "other"]]) {
    const result = spawnSync(process.execPath, [cli, "capability", "search", ...args], { cwd: f.root, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Capability search refused/u);
    assert.doesNotMatch(result.stdout, /installing|Installed|setup complete/iu);
  }
  const { searchCapabilities } = await load();
  const future = inventory([record("future")]); future.generatedAt = "2099-01-01T00:00:00.000Z";
  await writeFile(f.inventoryPath, JSON.stringify(future));
  assert.equal((await searchCapabilities({ ...f, query: "review" })).sources[0].state, "clock_skew");
});

test("search keeps qualified providers, exact runtime filtering and source-aware alias de-duplication", async (t) => {
  const f = await fixture(t, inventory([
    record("audit", { sourceKey: "codex:agents:provider-a:audit", collisionAliases: ["legacy-a"], providerId: "provider-a" }),
    record("audit", { sourceKey: "alias-copy", routesToSourceKey: "codex:agents:provider-a:audit", selectedAsWinner: false }),
    record("audit", { sourceKey: "codex:agents:provider-b:audit", providerId: "provider-b", sourceRef: "~/.codex/plugins/provider-b/audit.toml" }),
    record("foreign", { platformId: "claudeCode" }), record("app-only", { platformId: "codexapp" }),
  ]));
  const { searchCapabilities } = await load();
  const first = await searchCapabilities({ ...f, query: "code security", runtime: "codex", type: "agents", limit: 10 });
  assert.equal(first.candidates.length, 2);
  assert.deepEqual(new Set(first.candidates.map((item) => item.providerId)), new Set(["provider-a", "provider-b"]));
  assert.equal(first.candidates.find((item) => item.providerId === "provider-a").sourceKey, "codex:agents:provider-a:audit");
  assert.ok(first.candidates.every((item) => item.runtime === "codex" && item.qualifiedId));
  assert.deepEqual((await searchCapabilities({ ...f, query: "code security", runtime: "codex", type: "agents", limit: 10 })).candidates, first.candidates);
  await writeFile(f.inventoryPath, JSON.stringify(inventory([
    record("private-a", { sourceKey: "D:/private-a/provider.toml", sourceRef: "D:/private-a/provider.toml" }),
    record("private-b", { sourceKey: "E:/private-b/provider.toml", sourceRef: "E:/private-b/provider.toml" }),
  ])));
  const redacted = await searchCapabilities({ ...f, query: "review", runtime: "codex" });
  assert.equal(redacted.candidates.length, 2, "redaction must not merge different providers");
  assert.doesNotMatch(JSON.stringify(redacted.candidates), /D:\/private|E:\/private/u);
});

test("Unicode capability descriptions and explicit keywords match without guessing unrelated providers", async (t) => {
  const f = await fixture(t, inventory([record("review-one", { metadata: { description: "审查代码质量与安全性，发现漏洞。" } }), record("visual", { metadata: { description: "绘制插画和品牌配色" } })]));
  const { searchCapabilities } = await load();
  const result = await searchCapabilities({ ...f, query: "安全审查", runtime: "codex", type: "agents" });
  assert.equal(result.candidates[0].id, "review-one");
  assert.ok(result.candidates[0].matchedFields.includes("description"));
  const expanded = await searchCapabilities({ ...f, query: "security", keywords: ["安全", "漏洞"], runtime: "codex" });
  assert.equal(expanded.candidates.length, 1);
  const gap = await searchCapabilities({ ...f, query: "quantum orbital calibration", runtime: "codex" });
  assert.equal(gap.status, "capability_gap");
  assert.equal(gap.candidates.length, 0);
});

test("unavailable, malformed, old and unknown-time inventories never masquerade as fresh discovery", async (t) => {
  const f = await fixture(t);
  const { searchCapabilities } = await load();
  const options = { ...f, query: "code review", runtime: "codex" };
  await writeFile(f.inventoryPath, "{broken");
  let result = await searchCapabilities(options);
  assert.equal(result.sources[0].state, "invalid");
  assert.equal(result.status, "capability_gap");
  assert.match(result.refreshCommand, /discover-global-capabilities|discover:global/u);
  const old = inventory([record("old-review")]); old.generatedAt = "2020-01-01T00:00:00.000Z";
  await writeFile(f.inventoryPath, JSON.stringify(old));
  result = await searchCapabilities(options);
  assert.equal(result.sources[0].state, "stale");
  assert.equal(result.candidates[0].inventoryState, "stale");
  assert.equal(result.candidates[0].invocationState, "not_invoked");
  old.generatedAt = "bad";
  await writeFile(f.inventoryPath, JSON.stringify(old));
  assert.equal((await searchCapabilities(options)).sources[0].state, "invalid");
  await rm(f.inventoryPath);
  assert.equal((await searchCapabilities(options)).sources[0].state, "missing");
});

test("input bounds and declared canonical runtime coverage are enforced", async (t) => {
  const f = await fixture(t, inventory([]));
  const { searchCapabilities } = await load();
  for (const change of [{ query: "" }, { query: " ", keywords: ["review"] }, { query: "x".repeat(513) }, { limit: 99 }, { runtime: "not-runtime" }, { type: "not-type" }]) {
    await assert.rejects(searchCapabilities({ ...f, query: "review", ...change }), /invalid|limit|query|runtime|type/u);
  }
  await writeFile(f.canonicalPath, JSON.stringify({ registryName: "meta-kim-capabilities", generatedAt: now, byCapabilityType: { skills: {
    "repo:canonical:review": { id: "review", path: "canonical/skills/review/SKILL.md", description: "Review code" },
    "repo:declared:review": { id: "declared-review", path: "canonical/skills/declared/SKILL.md", description: "Review code", runtimeTargets: ["codex"] },
  } } }));
  const result = await searchCapabilities({ ...f, query: "review", runtime: "codex", type: "skills" });
  assert.deepEqual(result.candidates.map((item) => item.id), ["declared-review"]);
  assert.equal(result.candidates[0].sourceClass, "canonical");
});
