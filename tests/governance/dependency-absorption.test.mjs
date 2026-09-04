import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const readJson = async (relative) => JSON.parse(await readFile(path.join(repoRoot, relative), "utf8"));

test("planning-with-files is removed while its historical evidence remains", async () => {
  const contract = await readJson("config/contracts/dependency-absorption-contract.json");
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

test("unrelated projects are not reclassified by this gate", async () => {
  const manifest = await readJson("config/skills.json");
  for (const id of ["superpowers", "ecc", "cli-anything", "gstack"]) {
    const skill = manifest.skills.find((entry) => entry.id === id);
    assert.equal(skill.dependencyClass, undefined, `${id} was reclassified`);
    assert.equal(skill.installPolicy, undefined, `${id} install policy was changed`);
  }
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
  assert.match(result.stdout, /planning-with-files closed; next dependency blocked/);
});
