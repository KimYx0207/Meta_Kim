import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { kimDecisionRecord } from "../../scripts/discover-dependency-capabilities.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const installer = path.join(repoRoot, "scripts/install-global-skills-all-runtimes.mjs");
const manifest = JSON.parse(readFileSync(path.join(repoRoot,"config/skills.json"),"utf8"));
const specs = [
  ["agent-teams-playbook", "skills/agent-teams-playbook"], ["findskill", "skills/find-skill"],
  ["hookprompt", "hooks/hookprompt"], ["meta-skill-creator", "skills/meta-skill-creator"],
  ["goalpro", "skills/goalpro"], ["kim-decision", "skills/kim-decision"],
];
function put(file, content) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); }
function treeHash(root, includeGit = false) {
  const hash = createHash("sha256");
  function visit(dir) {
    for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (name.name === ".git" && !includeGit) continue;
      const full = path.join(dir, name.name);
      if (name.isDirectory()) visit(full);
      else if (name.isFile()) hash.update(path.relative(root, full)).update(readFileSync(full));
      else assert.fail("Unexpected linked fixture source");
    }
  }
  visit(root); return hash.digest("hex");
}
function sourceHash(source) {
  return createHash("sha256").update(JSON.stringify(specs.map(([,subdir])=>[subdir,treeHash(path.join(source,subdir))])))
    .update(readFileSync(path.join(source,"generated/capabilities.json"))).digest("hex");
}
function sandbox(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-service-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); mkdirSync(home);
  const hook = path.join(root, "deny-network.mjs");
  const networkLog = path.join(root, "network-attempts.jsonl");
  put(hook, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import {appendFileSync} from 'node:fs';
for (const key of ['spawn','spawnSync','execFile','execFileSync']) { const original=cp[key]; cp[key]=function(command,args,...rest) { if(/(?:^|[\\\\/])git(?:\\.exe)?$/i.test(String(command)) && Array.isArray(args) && args.some(v=>['clone','fetch','pull','ls-remote'].includes(v))) { appendFileSync(${JSON.stringify(networkLog)},JSON.stringify({command:String(command),operation:args[0]})+'\\n'); throw new Error('Offline test rejected a network Git invocation'); } return original.call(this,command,args,...rest); }; } syncBuiltinESMExports();`);
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PROCESSOR_ARCHITECTURE"]) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home,"appdata"), LOCALAPPDATA: path.join(home,"local"), TEMP: root, TMP: root,
    META_KIM_CLAUDE_HOME: path.join(home,".claude"), META_KIM_CODEX_HOME: path.join(home,".codex"), META_KIM_CURSOR_HOME: path.join(home,".cursor"), META_KIM_OPENCLAW_HOME: path.join(home,".openclaw"), META_KIM_SKIP_OPTIONAL_TOOLS: "1", NODE_OPTIONS: `--import=${new URL(`file:///${hook.replaceAll("\\", "/")}`).href}` });
  return { root, home, env, networkLog };
}
function fixture(root) {
  const source = path.join(root, "source", "Kim_Service"); mkdirSync(path.join(source, ".git"), { recursive: true });
  const components = [];
  for (const [id, subdir] of specs) {
    const base = path.join(source, subdir); const type = id === "hookprompt" ? "hook" : "skill";
    const entrypoint = type === "hook" ? ".claude/hooks/user-prompt-submit.js" : "SKILL.md";
    put(path.join(base, entrypoint), type === "hook" ? "process.stdout.write('{}');\n" : `---\nname: ${path.posix.basename(subdir)}\ndescription: Offline installation regression fixture.\n---\n\n# Fixture\n`);
    put(path.join(base, "LICENSE"), "fixture license\n"); put(path.join(base, "NOTICE"), "fixture notice\n");
    put(path.join(base, "capability.json"), JSON.stringify({ schemaVersion:1, id:path.posix.basename(subdir), componentType:type, entrypoint }));
    components.push({ id:path.posix.basename(subdir), path:subdir, componentType:type });
    if (type === "hook") {
      put(path.join(base, ".claude/prompt-optimizer-meta.md"), "fixture optimizer\n");
      put(path.join(base, ".codex/hooks/user-prompt-submit.js"), "import '../../.claude/hooks/user-prompt-submit.js';\n");
    }
  }
  put(path.join(source, "generated/capabilities.json"), JSON.stringify({ schemaVersion:1, components }));
  return source;
}
function run(ctx, source, { ids = specs.map(([id])=>id), targets = "claude,codex,cursor,openclaw", update = false, local = true } = {}) {
  const args = [installer, "--targets", targets, "--skills", ids.join(","), "--skip-plugins", "--skip-inventory-refresh"];
  if (local) args.push("--prefer-local-dependencies"); if (update) args.push("--update");
  const result = spawnSync(process.execPath, args, { cwd: ctx.root, env: { ...ctx.env, META_KIM_LOCAL_DEPENDENCY_ROOT: source }, encoding:"utf8", timeout:90000, maxBuffer:8*1024*1024 });
  const evidenceRoot = process.env.META_KIM_SERVICE_TEST_EVIDENCE;
  if (evidenceRoot) { mkdirSync(evidenceRoot,{recursive:true}); const label=`${Date.now()}-${ids.join("-")}-${update?"update":"install"}`; put(path.join(evidenceRoot,`${label}.stdout.log`), result.stdout ?? ""); put(path.join(evidenceRoot,`${label}.stderr.log`), result.stderr ?? ""); put(path.join(evidenceRoot,`${label}.json`),JSON.stringify({args,status:result.status,errorCode:result.error?.code,source,home:ctx.home,networkAttempts:existsSync(ctx.networkLog)?readFileSync(ctx.networkLog,"utf8"):""},null,2)); }
  assert.equal(existsSync(ctx.networkLog), false, "Product must not attempt remote clone/fetch");
  return result;
}
function passed(result) { assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`); }
function legacyBackup(target) {
  const root = path.join(path.dirname(path.dirname(target)), ".meta-kim", "legacy-dependency-backups");
  const name = readdirSync(root).find(entry => entry.startsWith(`${path.basename(target)}.legacy-preserved-`));
  assert.ok(name);
  assert.equal(readdirSync(path.dirname(target)).some(entry => entry.includes(".legacy-preserved-")), false);
  return path.join(root, name);
}
function mockRemoteSource(ctx, source) {
  const worker = path.join(ctx.root, "mock-git-worker.mjs");
  put(worker, `import {cpSync,mkdirSync} from 'node:fs'; const args=JSON.parse(process.argv[2]); if(args[0]==='clone'){mkdirSync(args.at(-1),{recursive:true});cpSync(${JSON.stringify(source)},args.at(-1),{recursive:true});}`);
  const hook = path.join(ctx.root, "mock-git.mjs");
  put(hook, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
for(const key of ['spawn','spawnSync']){const original=cp[key];cp[key]=function(command,args,options){if(/(?:^|[\\\\/])git(?:\\.exe)?$/i.test(String(command))&&['clone','sparse-checkout'].includes(args?.[0]))return original.call(this,process.execPath,[${JSON.stringify(worker)},JSON.stringify(args)],options);return original.apply(this,arguments);};}syncBuiltinESMExports();`);
  ctx.env.NODE_OPTIONS += ` --import=${new URL(`file:///${hook.replaceAll("\\", "/")}`).href}`;
}
function verifySix(ctx, source) {
  for (const [id, subdir] of specs) {
    const skillSpec=manifest.skills.find(item=>item.id===id);
    for (const runtime of skillSpec.targets) {
      const roots=runtime==="codex" && id==="meta-skill-creator" ? [".agents",".codex"] : [`.${runtime}`];
      for (const root of roots) {
      const skill=path.join(ctx.home,root,"skills",id);
      assert.ok(existsSync(path.join(skill,id==="hookprompt"?".claude/hooks/user-prompt-submit.js":"SKILL.md")),`${runtime}/${id}`);
      for(const name of ["LICENSE","NOTICE"]) assert.deepEqual(readFileSync(path.join(skill,name)),readFileSync(path.join(source,subdir,name)),`${runtime}/${id}/${name}`);
      for(const name of [".git","skills","hooks","generated"]) assert.equal(existsSync(path.join(skill,name)),false,`${runtime}/${id} must project a component root`);
      }
    }
  }
  assert.ok(existsSync(path.join(ctx.home,".agents/skills/meta-skill-creator/SKILL.md")));
  assert.ok(existsSync(path.join(ctx.home,".codex/skills/meta-skill-creator/SKILL.md")));
  assert.ok(existsSync(path.join(ctx.home,".claude/hooks/user-prompt-submit.js")));
  assert.deepEqual(readFileSync(path.join(ctx.home,".claude/prompt-optimizer-meta.md")),readFileSync(path.join(source,"hooks/hookprompt/.claude/prompt-optimizer-meta.md")));
  assert.ok(existsSync(path.join(ctx.home,".codex/hooks.json")));
  assert.ok(existsSync(path.join(ctx.home,".cursor/hooks.json")));
}
test("six Service components install and update offline with Hook and license closure", (t) => {
  const ctx=sandbox(t); const source=fixture(ctx.root); const before=sourceHash(source);
  put(path.join(ctx.home,".claude/user-owned.txt"),"preserve\n");
  passed(run(ctx,source)); verifySix(ctx,source); passed(run(ctx,source,{update:true})); verifySix(ctx,source);
  assert.equal(readFileSync(path.join(ctx.home,".claude/user-owned.txt"),"utf8"),"preserve\n"); assert.equal(sourceHash(source),before);
});
test("an existing later runtime supplies missing runtimes and Hook attachments without a local checkout", (t) => {
  const ctx=sandbox(t); const source=fixture(ctx.root); passed(run(ctx,source));
  rmSync(path.join(ctx.home,".claude/skills"),{recursive:true}); rmSync(path.join(ctx.home,".agents/skills/meta-skill-creator"),{recursive:true}); rmSync(path.join(ctx.home,".claude/hooks/user-prompt-submit.js")); rmSync(path.join(ctx.home,".claude/prompt-optimizer-meta.md"));
  passed(run(ctx,path.join(ctx.root,"no-checkout"),{local:false})); verifySix(ctx,source);
});
test("single-runtime local install also uses the real component source", (t) => {
  const ctx=sandbox(t); const source=fixture(ctx.root); passed(run(ctx,source,{targets:"claude"}));
  for (const [id] of specs) assert.ok(existsSync(path.join(ctx.home,".claude/skills",id,id==="hookprompt"?".claude/hooks/user-prompt-submit.js":"SKILL.md")));
});
test("declared whole runtime redirects support repeat install and update without allowing inner links", (t) => {
  const ctx = sandbox(t); const source = fixture(ctx.root);
  const physical = path.join(ctx.root, "physical-claude-home"); mkdirSync(physical);
  symlinkSync(physical, path.join(ctx.home, ".claude"), process.platform === "win32" ? "junction" : "dir");
  for (const options of [{}, {}, { update: true }]) {
    passed(run(ctx, source, { targets: "claude", ...options }));
  }
  const target = path.join(physical, "skills/goalpro");
  const outside = path.join(ctx.root, "outside-target"); renameSync(target, outside);
  const before = treeHash(outside, true);
  symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir");
  const rejected = run(ctx, source, { ids: ["goalpro"], targets: "claude", update: true });
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /symlink|junction|plain directory/);
  assert.equal(treeHash(outside, true), before);
});
test("missing explicit subdir and required Hook attachment fail without network fallback", (t) => {
  const ctx=sandbox(t); const source=fixture(ctx.root); rmSync(path.join(source,"skills/goalpro"),{recursive:true});
  const missing=run(ctx,source,{ids:["goalpro"]}); assert.notEqual(missing.status,0); assert.match(missing.stderr,/local component.*(?:invalid|missing)/i);
  const second=sandbox(t); const complete=fixture(second.root); rmSync(path.join(complete,"hooks/hookprompt/.claude/prompt-optimizer-meta.md"));
  const oldHook = path.join(second.home, ".claude/skills/hookprompt");
  cpSync(path.join(complete, "hooks/hookprompt"), oldHook, { recursive: true });
  put(path.join(oldHook, ".claude/prompt-optimizer-meta.md"), "old optimizer\n");
  const oldHash = treeHash(oldHook, true);
  const hook=run(second,complete,{ids:["hookprompt"],update:true}); assert.notEqual(hook.status,0); assert.match(hook.stderr,/ENOENT|prompt-optimizer/);
  assert.equal(treeHash(oldHook, true), oldHash);
});
test("a mismatched local Skill entrypoint fails before replacing an installed component", (t) => {
  const ctx = sandbox(t); const source = fixture(ctx.root);
  passed(run(ctx, source, { ids: ["goalpro"], targets: "claude" }));
  const target = path.join(ctx.home, ".claude/skills/goalpro"); const before = treeHash(target, true);
  put(path.join(source, "skills/goalpro/SKILL.md"), "---\nname: unrelated\ndescription: Wrong component.\n---\n");
  const result = run(ctx, source, { ids: ["goalpro"], targets: "claude", update: true });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /no valid matching entrypoint/);
  assert.equal(treeHash(target, true), before);
});
test("a rejected local multi-stage extraction never falls back to a per-runtime remote install", (t) => {
  const ctx=sandbox(t); const source=fixture(ctx.root); rmSync(path.join(source,"skills/goalpro"),{recursive:true});
  put(path.join(ctx.home,".claude/skills/goalpro/user-owned.txt"),"unchanged\n");
  // Parent-directory declaration uses the existing repoName lookup, so failure occurs in staging.
  const missing=run(ctx,path.dirname(source),{ids:["goalpro"],update:true});
  assert.notEqual(missing.status,0); assert.match(missing.stderr,/Local dependency source missing/);
  assert.equal(readFileSync(path.join(ctx.home,".claude/skills/goalpro/user-owned.txt"),"utf8"),"unchanged\n");
});
test("a recognized explicit Service root missing its index fails without network or old-target mutation", (t) => {
  const ctx=sandbox(t); const original=fixture(ctx.root); const source=path.join(ctx.root,"explicit-service-worktree"); renameSync(original,source);
  rmSync(path.join(source,"generated/capabilities.json"));
  const target=path.join(ctx.home,".claude/skills/goalpro");
  cpSync(path.join(source,"skills/goalpro"),target,{recursive:true}); put(path.join(target,"user-owned.txt"),"old target content\n");
  const before=treeHash(target,true);
  const result=run(ctx,source,{ids:["goalpro"],update:true}); assert.notEqual(result.status,0);
  assert.match(result.stderr,/Declared local Kim_Service capability index is missing: generated\/capabilities\.json/);
  assert.equal(treeHash(target,true),before);
  // An arbitrary parent checkout is still a parent declaration, not a direct Service root.
  const parentContext=sandbox(t); const complete=fixture(parentContext.root); const parent=path.dirname(complete);
  mkdirSync(path.join(parent,".git"));
  passed(run(parentContext,parent,{ids:["goalpro"]}));
  assert.ok(existsSync(path.join(parentContext.home,".claude/skills/goalpro/SKILL.md")));
});
test("explicit partial Service source reads only the requested component", (t) => {
  const ctx=sandbox(t); const source=fixture(ctx.root);
  for (const [id,subdir] of specs) if(id!=="findskill") rmSync(path.join(source,subdir),{recursive:true});
  put(path.join(source,"generated/capabilities.json"),JSON.stringify({schemaVersion:1,components:[{id:"find-skill",componentType:"skill",path:"skills/find-skill"}]}));
  passed(run(ctx,source,{ids:["findskill"],targets:"claude,codex"}));
  assert.ok(existsSync(path.join(ctx.home,".claude/skills/findskill/SKILL.md"))); assert.ok(existsSync(path.join(ctx.home,".codex/skills/findskill/SKILL.md")));
});
test("local component junctions and unknown meta-skill roots fail closed before replacement", (t) => {
  const ctx=sandbox(t); const source=fixture(ctx.root); const outside=path.join(ctx.root,"outside"); mkdirSync(outside); put(path.join(outside,"user-owned.txt"),"external\n");
  symlinkSync(outside,path.join(source,"skills/goalpro/linked"),process.platform==="win32"?"junction":"dir");
  const linked=run(ctx,source,{ids:["goalpro"]}); assert.notEqual(linked.status,0); assert.match(linked.stderr,/symlink|junction/);
  assert.equal(readFileSync(path.join(outside,"user-owned.txt"),"utf8"),"external\n");
  const second=sandbox(t); const complete=fixture(second.root); const target=path.join(second.home,".claude/skills/meta-skill-creator"); put(path.join(target,"user-owned.txt"),"meta-user\n");
  const denied=run(second,complete,{ids:["meta-skill-creator"]}); assert.notEqual(denied.status,0); assert.equal(readFileSync(path.join(target,"user-owned.txt"),"utf8"),"meta-user\n");
});
test("HookPrompt refuses settings redirects without modifying the outside file", (t) => {
  const ctx = sandbox(t); const source = fixture(ctx.root);
  const external = path.join(ctx.root, "outside-settings.json");
  put(external, '{"userOwned":true}\n'); mkdirSync(path.join(ctx.home, ".claude"));
  symlinkSync(external, path.join(ctx.home, ".claude/settings.json"), "file");
  const result = run(ctx, source, { ids: ["hookprompt"], targets: "claude" });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /symlink|junction/);
  assert.equal(readFileSync(external, "utf8"), '{"userOwned":true}\n');
});
test("unknown target is preserved before repair; recognized historical repo is retained as a backup", (t) => {
  const ctx=sandbox(t); const source=fixture(ctx.root); const target=path.join(ctx.home,".claude/skills/agent-teams-playbook"); put(path.join(target,"user-owned.txt"),"keep\n");
  const denied=run(ctx,source,{ids:["agent-teams-playbook"]}); assert.notEqual(denied.status,0); assert.equal(readFileSync(path.join(target,"user-owned.txt"),"utf8"),"keep\n");
  put(path.join(target,".git/config"),'[remote "origin"]\n url = https://github.com/KimYx0207/agent-teams-playbook.git\n'); cpSync(path.join(source,"skills/agent-teams-playbook"),path.join(target,"skills/agent-teams-playbook"),{recursive:true});
  passed(run(ctx,source,{ids:["agent-teams-playbook"]})); assert.ok(existsSync(path.join(target,"SKILL.md")));
  assert.equal(readFileSync(path.join(legacyBackup(target),"user-owned.txt"),"utf8"),"keep\n");
});
test("unowned matching Service entrypoints do not authorize directory replacement or adoption", (t) => {
  for (const [id] of specs) {
    const ctx = sandbox(t); const source = fixture(ctx.root);
    const subdir = specs.find(([candidate]) => candidate === id)[1];
    const target = path.join(ctx.home, ".claude/skills", id);
    cpSync(path.join(source, subdir), target, { recursive: true });
    put(path.join(target, "user-owned-notes.txt"), "Keep this user content beside the matching entrypoint.\n");
    const before = treeHash(target, true);
    const result = run(ctx, source, { ids: [id], targets: "claude", update: true });
    t.diagnostic(JSON.stringify({ id, exitCode: result.status, userFilePreserved: existsSync(path.join(target, "user-owned-notes.txt")), directoryUnchanged: treeHash(target, true) === before }));
    assert.notEqual(result.status, 0, `${id}: a matching entrypoint is not an ownership receipt`);
    assert.equal(treeHash(target, true), before, `${id}: preserve the whole unowned directory`);
    const ledger = path.join(ctx.home, ".meta-kim/install-manifest.json");
    if (existsSync(ledger)) assert.equal(JSON.parse(readFileSync(ledger)).entries.some((entry) => entry.path === target), false);
  }
});
test("unowned matching targets remain intact on multi-runtime and remote update routes", (t) => {
  for (const options of [{ targets: "claude,codex" }, { targets: "claude", local: false }]) {
    const ctx = sandbox(t); const source = fixture(ctx.root);
    const target = path.join(ctx.home, ".claude/skills/goalpro");
    cpSync(path.join(source, "skills/goalpro"), target, { recursive: true });
    put(path.join(target, "private-notes.txt"), "fixture only\n");
    const before = treeHash(target, true); mockRemoteSource(ctx, source);
    const denied = run(ctx, source, { ids: ["goalpro"], update: true, ...options });
    assert.notEqual(denied.status, 0); assert.match(denied.stderr, /ownership receipt.*preserved without replacement/);
    assert.equal(treeHash(target, true), before);
  }
});
test("only the exact unchanged installer receipt permits replacement; drift never gets re-adopted", (t) => {
  const ctx = sandbox(t); const source = fixture(ctx.root);
  passed(run(ctx, source, { ids: ["goalpro"], targets: "claude" }));
  const target = path.join(ctx.home, ".claude/skills/goalpro");
  const ledger = path.join(ctx.home, ".meta-kim/install-manifest.json");
  const originalReceipt = readFileSync(ledger, "utf8");
  const before = treeHash(target, true);
  for (const mutation of [
    { source: "unrelated-writer" }, { purpose: "unrelated-global-skill" }, { path: path.join(ctx.home, ".claude/skills/same-name-elsewhere") },
    { directoryClosureSha256: "0".repeat(64) }, { directoryClosureEntryCount: 999 }, { ownershipClass: "runtime_sedimented_project_copy" },
    { ownershipClass: "user_owned" }, { ownershipClass: "canonical_source" },
  ]) {
    const value = JSON.parse(originalReceipt); Object.assign(value.entries.find((entry) => entry.path === target), mutation);
    put(ledger, JSON.stringify(value));
    const rejected = run(ctx, source, { ids: ["goalpro"], targets: "claude", update: true });
    assert.notEqual(rejected.status, 0, JSON.stringify(mutation)); assert.equal(treeHash(target, true), before);
  }
  put(ledger, originalReceipt);
  put(path.join(source, "skills/goalpro/SKILL.md"), "---\nname: goalpro\ndescription: Updated verified source.\n---\n\n# Updated source\n");
  passed(run(ctx, source, { ids: ["goalpro"], targets: "claude", update: true }));
  assert.match(readFileSync(path.join(target, "SKILL.md"), "utf8"), /Updated source/);
  for (const ownershipClass of [null, "install_projection"]) {
    const value = JSON.parse(readFileSync(ledger)); value.entries.find((entry) => entry.path === target).ownershipClass = ownershipClass;
    put(ledger, JSON.stringify(value));
    put(path.join(source, "skills/goalpro/NOTICE"), `Updated source for ${ownershipClass ?? "legacy null"}\n`);
    passed(run(ctx, source, { ids: ["goalpro"], targets: "claude", update: true }));
    assert.equal(readFileSync(path.join(target, "NOTICE"), "utf8"), readFileSync(path.join(source, "skills/goalpro/NOTICE"), "utf8"));
  }
  const managedReceipt = readFileSync(ledger, "utf8");
  put(path.join(target, "user-owned-after-install.txt"), "do not erase this addition\n");
  const drifted = treeHash(target, true);
  const rejected = run(ctx, source, { ids: ["goalpro"], targets: "claude", update: true });
  assert.notEqual(rejected.status, 0); assert.equal(treeHash(target, true), drifted);
  const current = JSON.parse(readFileSync(ledger)); const previous = JSON.parse(managedReceipt);
  assert.deepEqual(current.entries.find((entry) => entry.path === target), previous.entries.find((entry) => entry.path === target));
});
test("single-runtime remote route preserves unknown and historical targets through the same deployment boundary", (t) => {
  const ctx = sandbox(t); const source = fixture(ctx.root);
  const target = path.join(ctx.home, ".claude/skills/agent-teams-playbook");
  put(path.join(target, "user-owned.txt"), "remote-preserve\n");
  const unknown = run(ctx, source, { ids: ["agent-teams-playbook"], targets: "claude", update: true, local: false });
  assert.notEqual(unknown.status, 0); assert.match(unknown.stderr, /preserved without replacement/);
  assert.equal(readFileSync(path.join(target, "user-owned.txt"), "utf8"), "remote-preserve\n");
  put(path.join(target, ".git/config"), '[remote "origin"]\n url = https://github.com/KimYx0207/agent-teams-playbook.git\n');
  cpSync(path.join(source, "skills/agent-teams-playbook"), path.join(target, "skills/agent-teams-playbook"), { recursive: true });
  const before = treeHash(target, true); mockRemoteSource(ctx, source);
  passed(run(ctx, source, { ids: ["agent-teams-playbook"], targets: "claude", update: true, local: false }));
  assert.equal(treeHash(legacyBackup(target), true), before);
  assert.ok(existsSync(path.join(target, "SKILL.md")));
  assert.equal(existsSync(path.join(target, ".git")), false);
});
test("historical Git repositories with valid root Skill or Hook entries retain their full old roots on update", (t) => {
  for (const id of ["agent-teams-playbook","hookprompt","meta-skill-creator"]) {
    const ctx=sandbox(t); const source=fixture(ctx.root); const subdir=specs.find(([candidate])=>candidate===id)[1];
    const target=path.join(ctx.home,".claude/skills",id); cpSync(path.join(source,subdir),target,{recursive:true});
    const registry=JSON.parse(readFileSync(path.join(repoRoot,"config/capability-index/dependency-project-registry.json"),"utf8"));
    const history=registry.projects.find(item=>item.id===id).source.history[0];
    const origin=history.uri.replaceAll("${skillOwner}",manifest.skillOwner);
    const gitConfig=`[remote "origin"]\n url = ${origin}.git\n`;
    put(path.join(target,".git/config"),gitConfig); put(path.join(target,"user-extra.txt"),"old user content\n");
    put(path.join(target,".git/HEAD"),"ref: refs/heads/legacy\n");
    put(path.join(target,"old-repository-only/file.txt"),"old repo payload\n"); const oldHash=treeHash(target,true);
    passed(run(ctx,source,{ids:[id],update:true}));
    const backup=legacyBackup(target); assert.equal(treeHash(backup,true),oldHash); assert.equal(readFileSync(path.join(backup,".git/config"),"utf8"),gitConfig);
    assert.equal(existsSync(path.join(target,".git")),false); assert.equal(existsSync(path.join(target,"user-extra.txt")),false); assert.equal(existsSync(path.join(target,"old-repository-only")),false);
    const inventory = spawnSync(process.execPath, [path.join(repoRoot, "scripts/discover-global-capabilities.mjs"), "--runtime-inventory-only", "--targets", "claude,codex", "--json"], { cwd: ctx.root, env: ctx.env, encoding: "utf8", timeout: 30_000 });
    passed(inventory);
    const index = JSON.parse(inventory.stdout);
    assert.equal(JSON.stringify(index).includes("legacy-preserved"), false, "Historical backups must not be rediscovered as skills");
  }
});
test("kim-decision source discovery remains reference-only and ignores incomplete earlier roots", async (t) => {
  const ctx=sandbox(t); const source=fixture(ctx.root); const wrong=path.join(ctx.root,"wrong"); mkdirSync(wrong);
  const record=await kimDecisionRecord({projectRoot:ctx.root, environment:{META_KIM_DEP_ROOTS:[wrong,source].join(path.delimiter)}});
  assert.equal(record.routeEligibility,"reference_only"); assert.equal(record.invokeAs,"reference"); assert.equal(record.invocationPath,null); assert.equal(record.sourceAvailability.status,"verified_local");
  const missing=await kimDecisionRecord({projectRoot:ctx.root,environment:{META_KIM_KIM_SERVICE_ROOT:wrong,META_KIM_DEP_ROOTS:source}}); assert.equal(missing.sourceAvailability.status,"needs_probe");
});
test("actual readonly Service checkout installs and updates through the same product paths", {skip: !process.env.META_KIM_TEST_KIM_SERVICE_SOURCE}, (t) => {
  const ctx=sandbox(t); const source=process.env.META_KIM_TEST_KIM_SERVICE_SOURCE;
  const before=sourceHash(source); passed(run(ctx,source)); verifySix(ctx,source); passed(run(ctx,source,{update:true})); verifySix(ctx,source); assert.equal(sourceHash(source),before);
});
