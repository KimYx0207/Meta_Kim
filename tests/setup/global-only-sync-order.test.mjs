import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const modes = { A: [], B: ["--targets", "claude,codex"] };

function write(root, relative, content) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-sync-order-"));
  for (const name of ["package.json", "config", "canonical"]) {
    cpSync(path.join(repoRoot, name), path.join(root, name), { recursive: true });
  }
  write(root, ".meta-kim/local.overrides.json", JSON.stringify({ projectProjectionMode: "global_only" }));
  const preserved = {
    ".claude/agents/user-owned.md": "user-owned agent\n",
    ".agents/skills/custom-project-skill/SKILL.md": "# local skill\n",
    ".agents/skills/custom-project-skill/references/user-note.md": "preserved descendant\n",
  };
  for (const [relative, content] of Object.entries(preserved)) write(root, relative, content);
  write(root, ".meta-kim/state/default/project-capabilities.json", JSON.stringify({
    schemaVersion: "meta-kim-project-capabilities-v0.1",
    capabilities: [{ type: "skill", ownershipClass: "runtime_sedimented_project_copy",
      dependencyUpdatePolicy: "preserve_project_copy",
      files: [{ relPath: ".agents/skills/custom-project-skill/SKILL.md" }] }],
  }));
  const relative = ".agents/skills/custom-project-skill/references/user-note.md";
  const now = new Date().toISOString();
  write(root, ".meta-kim/install-manifest.json", JSON.stringify({
    schemaVersion: 1, scope: "project", metaKimVersion: "test", repoRoot: root,
    createdAt: now, updatedAt: now,
    entries: [{ path: path.join(root, relative), category: "D", source: "sync-runtimes",
      purpose: "project-skill", kind: "file", installedAt: now,
      sha256: createHash("sha256").update(preserved[relative]).digest("hex"),
      size: Buffer.byteLength(preserved[relative]) }],
  }));
  return { root, preserved };
}

function run(root, args) {
  const home = path.join(root, "isolated-home");
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts/sync-runtimes.mjs"), ...args], {
    cwd: root, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, META_KIM_REPO_ROOT: root, META_KIM_CALLER_CWD: root,
      HOME: home, USERPROFILE: home, META_KIM_CLAUDE_HOME: path.join(home, ".claude"),
      META_KIM_CODEX_HOME: path.join(home, ".codex"), META_KIM_CURSOR_HOME: path.join(home, ".cursor") },
  });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function assertState(root, preserved) {
  for (const [relative, content] of Object.entries(preserved)) {
    assert.equal(readFileSync(path.join(root, relative), "utf8"), content, relative);
  }
  assert.deepEqual(readdirSync(path.join(root, ".claude/agents")), ["user-owned.md"]);
  assert.deepEqual(readdirSync(path.join(root, ".agents/skills")), ["custom-project-skill"]);
  for (const relative of [".claude/skills", ".claude/commands", ".claude/capability-index",
    ".codex/agents", ".codex/capability-index", ".cursor/agents", "openclaw"]) {
    assert.equal(existsSync(path.join(root, relative)), false, `unexpected durable projection: ${relative}`);
  }
  const snapshot = {};
  for (const runtime of [".claude", ".codex"]) {
    const hooks = path.join(root, runtime, "hooks");
    for (const name of ["activate-meta-theory-spine.mjs", "project-root.mjs", "spine-state-gates.mjs"]) {
      assert.ok(existsSync(path.join(hooks, name)), `${runtime}/${name} missing`);
    }
    for (const name of readdirSync(hooks).filter((item) => item.endsWith(".mjs"))) {
      const source = readFileSync(path.join(hooks, name), "utf8");
      for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.[^"']+\.mjs)["']/gu)) {
        assert.ok(existsSync(path.resolve(hooks, match[1])), `${runtime}/${name} missing dependency ${match[1]}`);
      }
      snapshot[`${runtime}/${name}`] = createHash("sha256").update(source).digest("hex");
    }
  }
  return snapshot;
}

for (const order of [["A", "B", "A"], ["B", "A", "B"]]) {
  test(`global_only sync order ${order.join(" -> ")} preserves scope, Hook closure and project ownership`, (t) => {
    const { root, preserved } = fixture();
    try {
      let firstSnapshot;
      for (const [index, mode] of order.entries()) {
        run(root, modes[mode]);
        const snapshot = assertState(root, preserved);
        const checked = JSON.parse(run(root, [...modes[mode], "--check", "--json"]).stdout);
        assert.equal(checked.status, "ok");
        assert.deepEqual(checked.staleFiles, []);
        if (index === 0) firstSnapshot = snapshot;
        if (index === 2) assert.deepEqual(snapshot, firstSnapshot, "round trip must preserve Hook bytes");
        t.diagnostic(`step ${index + 1}: ${mode}, sync=0, check=0, hooks=${Object.keys(snapshot).length}, preserved=3`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
