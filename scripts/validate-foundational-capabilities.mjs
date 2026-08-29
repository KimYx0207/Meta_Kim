#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  OS_TARGETS,
  RUNTIMES,
  assert,
  exists,
  listFiles,
  readJson,
  repoPath,
} from "./governance-lib.mjs";
import {
  resolveRuntimeCapabilityClaim,
} from "./runtime-capability-claims.mjs";

const REQUIRED_SKILLS = [
  "agent-teams-playbook",
  "findskill",
  "hookprompt",
  "superpowers",
  "ecc",
  "cli-anything",
  "gstack",
  "meta-skill-creator",
];

const FOUNDATIONAL_CAPABILITIES = [
  "skill",
  "browser / web",
  "shell",
  "filesystem",
  "apply_patch / edit",
  "MCP",
  "memory",
  "graph",
  "hook",
  "command",
  "subagent",
  "approval",
  "sandbox",
];

const REQUIRED_SCRIPTS = [
  "meta:sync",
  "meta:deps:discover",
  "meta:capabilities:index",
  "meta:capabilities:route",
  "meta:governance:validate",
  "meta:runtime:validate",
  "meta:os:check",
  "meta:deps:check",
  "meta:route:validate",
  "meta:intent:validate",
  "meta:foundational:validate",
  "meta:prompt:validate",
  "meta:deps:compat",
  "meta:hook:validate",
  "meta:verify:governance",
];

const pkg = await readJson("package.json");
const skills = await readJson("config/skills.json");
const runtimeMatrix = await readJson("config/runtime-capability-matrix.json");
const osMatrix = await readJson("config/os-compatibility-matrix.json");
const weapons = await readJson("config/capability-index/weapon-registry.json");
const dependencies = await readJson("config/capability-index/dependency-project-registry.json");

const skillIds = new Set((skills.skills ?? []).map((skill) => skill.id));
for (const id of REQUIRED_SKILLS) {
  assert(skillIds.has(id), `config/skills.json missing preserved skill ${id}`);
}

assert(
  !skillIds.has("planning-with-files"),
  "retired planning-with-files dependency must not remain in config/skills.json",
);
assert(
  pkg.scripts?.["meta:planning:validate"],
  "Meta_Kim first-party planning continuity validator is required",
);

for (const scriptName of REQUIRED_SCRIPTS) {
  assert(pkg.scripts?.[scriptName], `package.json missing preserved script ${scriptName}`);
}

for (const capability of FOUNDATIONAL_CAPABILITIES) {
  assert(
    (runtimeMatrix.capabilityNames ?? []).includes(capability),
    `runtime matrix missing foundational capability ${capability}`,
  );
}

for (const runtime of RUNTIMES) {
  const platform = (runtimeMatrix.platforms ?? []).find((entry) => entry.platform === runtime);
  assert(platform, `runtime matrix missing ${runtime}`);
  const caps = new Map((platform.capabilities ?? []).map((cap) => [cap.capability, cap]));
  for (const capability of FOUNDATIONAL_CAPABILITIES) {
    const record = caps.get(capability);
    assert(record, `${runtime} missing foundational capability ${capability}`);
    assert(record.support !== "unsupported", `${runtime}.${capability} must not be removed or hard-unsupported`);
    assert(!(record.support === "native" && record.confidence === "unverified"), `${runtime}.${capability} native requires evidence`);
    const interactiveClaim = resolveRuntimeCapabilityClaim(runtimeMatrix, {
      runtime,
      capability,
      mode: "interactive_host",
    });
    assert(interactiveClaim.claim, `${runtime}.${capability} missing interactive_host claim`);
    assert(interactiveClaim.hostSupport !== "unsupported", `${runtime}.${capability} host capability must be preserved`);
  }
}

const cursorChoice = resolveRuntimeCapabilityClaim(runtimeMatrix, {
  runtime: "cursor",
  capability: "native choice surface",
  mode: "interactive_host",
});
assert(cursorChoice.hostSupport === "native", "Cursor host choice surface must remain documented as native");
assert(cursorChoice.executable === false, "Cursor docs-only choice surface must not become executable before acceptance");

const osIds = new Set((osMatrix.operatingSystems ?? []).map((entry) => entry.id));
for (const osName of OS_TARGETS) {
  assert(osIds.has(osName), `OS matrix missing ${osName}`);
}

for (const weapon of weapons.weapons ?? []) {
  assert(weapon.id, "weapon missing id");
  for (const osName of OS_TARGETS) assert(weapon.osSupport?.[osName], `${weapon.id} missing osSupport.${osName}`);
  for (const runtime of RUNTIMES) assert(weapon.runtimeSupport?.[runtime], `${weapon.id} missing runtimeSupport.${runtime}`);
}

const requiredDependencyIds = new Set(["agent-teams-playbook", "meta-kim-runtime", ...REQUIRED_SKILLS]);
const dependencyIds = new Set((dependencies.projects ?? []).map((project) => project.id));
for (const id of requiredDependencyIds) {
  assert(dependencyIds.has(id), `dependency registry missing preserved dependency ${id}`);
}

const repoTextFiles = [
  "canonical/skills/meta-theory/SKILL.md",
  "canonical/skills/meta-theory/references/dev-governance.md",
  "canonical/skills/meta-theory/references/evolution-writeback.md",
  "config/runtime-capability-matrix.json",
  "config/capability-index/weapon-registry.json",
  "config/capability-index/dependency-project-registry.json",
];
const combined = (await Promise.all(repoTextFiles.map((file) => fs.readFile(repoPath(file), "utf8")))).join("\n");
for (const term of ["web", "browser", "research", "MCP", "memory", "graph", "graphify", "hook", "shell", "filesystem", "apply_patch"]) {
  assert(new RegExp(term, "i").test(combined), `foundational term ${term} is no longer discoverable`);
}

const hookFiles = await listFiles(repoPath("canonical/runtime-assets"), (file) => /hooks|memory-hooks/.test(file));
assert(hookFiles.some((file) => file.includes("block-dangerous-bash")), "dangerous command blocker hook missing");
assert(hookFiles.some((file) => file.includes("memory-save")), "memory save hook missing");
assert(hookFiles.some((file) => file.includes("spine-state")), "session audit/spine hook missing");

const hardcodedPathPattern = /D:[/\\]KimProject[/\\]Kim_Decision/i;
for (const file of [
  "scripts/discover-dependency-capabilities.mjs",
  "config/capability-index/dependency-project-registry.json",
  "config/capability-index/weapon-registry.json",
]) {
  const text = await fs.readFile(repoPath(file), "utf8");
  assert(!hardcodedPathPattern.test(text), `${file} contains hardcoded personal Kim_Decision path`);
}

console.log("foundational capabilities preserved");
