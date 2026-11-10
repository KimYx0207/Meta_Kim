import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const readJson = async (relative) => JSON.parse(await readFile(path.join(repoRoot, relative), "utf8"));

test("planning-with-files is removed while its historical evidence remains", async () => {
  const current = await readJson("config/contracts/dependency-absorption-contract.json");
  const contract = current.historicalClosures.find((item) => item.activeItem?.id === "planning-with-files");
  const manifest = await readJson("config/skills.json");
  assert.equal(contract.maxActiveResearch, 1);
  assert.equal(contract.activeItem.id, "planning-with-files");
  assert.equal(contract.activeItem.deletionAuthorized, true);
  assert.equal(contract.activeItem.installedState, "removed");
  assert.equal(contract.activeItem.state, "DEPENDENCY_REMOVED_CLOSED");
  assert.equal(contract.closureReview.decision, "REVIEW_PASS");
  assert.equal(contract.closureReview.independentReviewCount, 2);
  assert.equal(contract.closureReview.nextProjectActivationAuthorized, false);
  assert.equal(contract.nextProjectActivationAllowed, false);
  assert.equal(manifest.skills.some((skill) => skill.id === "planning-with-files"), false);
});

test("optional upstream implementations stay installable without default activation", async () => {
  const manifest = await readJson("config/skills.json");
  for (const id of ["superpowers", "ecc", "cli-anything"]) {
    const skill = manifest.skills.find((entry) => entry.id === id);
    assert.equal(skill.dependencyClass, undefined, `${id} was reclassified`);
    assert.equal(skill.installPolicy, undefined, `${id} install policy was changed`);
    assert.equal(skill.defaultSelected, false, `${id} must not activate by default`);
  }
});

test("gstack is downgraded to a third-party reference, not unlinked", async () => {
  const manifest = await readJson("config/skills.json");
  const gstack = manifest.skills.find((entry) => entry.id === "gstack");
  assert.ok(gstack, "gstack must remain listed in config/skills.json");
  assert.equal(gstack.dependencyClass, "third_party_reference");
  assert.equal(gstack.installPolicy, "explicit_reference_opt_in");
});

test("planning-with-files is absent from the default execution loadout", async () => {
  const source = await readFile(path.join(repoRoot, "scripts/run-capability-gap-orchestration.mjs"), "utf8");
  assert.doesNotMatch(source, /runtimeSkillCandidates[^\n]*planning-with-files/u);
});

test("dependency absorption validator passes", () => {
  const result = spawnSync(process.execPath, ["scripts/validate-dependency-absorption.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /historical planning-with-files closed; 20 current dispositions; unknown user copies preserved/);
});

test("only the duplicate Meta decision install is retired; independent specialist and engines remain", async () => {
  const contract = await readJson("config/contracts/dependency-absorption-contract.json");
  const manifest = await readJson("config/skills.json");
  const byId = new Map(contract.currentReview.items.map((item) => [item.id, item]));
  assert.deepEqual(manifest.skills.filter((skill) => skill.defaultSelected !== false && skill.installPolicy !== "explicit_reference_opt_in").map((skill) => skill.id), ["meta-skill-creator"]);
  assert.equal(manifest.skills.some((skill) => skill.id === "kim-decision"), false);
  assert.equal(byId.get("kim-decision").managedCopyRetirement.unknownOrEdited, "preserve");
  assert.equal(byId.get("goalpro").decision, "methods_absorbed_optional_specialist");
  for (const id of ["ecc", "cli-anything", "graphifyy", "mcp-memory-service", "agent-desktop", "agent-browser"]) {
    assert.match(byId.get(id).decision, /^retain_/u);
    assert.equal(byId.get(id).liveExecutionClaim, false);
  }
});
