import assert from "node:assert/strict";
import { DEPENDENCY_BASELINE } from "./dependency-baseline.mjs";

/** Fetch a reviewed immutable revision; never silently substitute branch HEAD. */
export async function checkoutReviewedServiceSource({ directory, repositoryUrl,
  repository = DEPENDENCY_BASELINE.kimService.repository,
  commit = DEPENDENCY_BASELINE.kimService.commit, runGit }) {
  assert(/^[a-f0-9]{40}$/u.test(commit), "Service source requires a full commit SHA");
  assert(typeof runGit === "function", "Service source requires the installer Git transport");
  const invoke = async args => {
    const result = await runGit(args, { skillLabel: "Reviewed Kim_Service capability source" });
    assert.equal(result.status, 0, "Reviewed Service source checkout failed");
    return String(result.stdout ?? "").trim();
  };
  await invoke(["init", directory]);
  await invoke(["-C", directory, "remote", "add", "origin", repositoryUrl]);
  await invoke(["-C", directory, "fetch", "--depth", "1", "origin", commit]);
  await invoke(["-C", directory, "checkout", "--detach", "FETCH_HEAD"]);
  const actual = await invoke(["-C", directory, "rev-parse", "HEAD"]);
  assert.equal(actual, commit, "Service checkout differs from the reviewed commit");
  return { schemaVersion: 1, selection: "reviewed_commit", repository, commit };
}

/** Old/unversioned or explicitly local receipts remain readable, not reusable as a reviewed pin. */
export function matchesReviewedServiceSource(source, repository = DEPENDENCY_BASELINE.kimService.repository) {
  return source?.revision?.schemaVersion === 1 && source.revision.selection === "reviewed_commit"
    && source.revision.repository === repository
    && source.revision.commit === DEPENDENCY_BASELINE.kimService.commit;
}

/** Preserve an explicit local-source choice on ordinary reruns, without relabelling it as reviewed. */
export function reusableManagedServiceSource(source, repository) {
  const local = source?.revision?.schemaVersion === 1 && source.revision.selection === "local_override";
  return matchesReviewedServiceSource(source, repository) || local ? source.value : null;
}
