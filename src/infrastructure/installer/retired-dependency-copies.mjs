import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  directoryClosureSync,
  manifestPathFor,
  openRecorder,
  readManifest,
} from "../../../scripts/install-manifest.mjs";
import {
  assertInstallerWritePath,
  createInstallerWriteBoundary,
} from "../../../scripts/installer-write-boundary.mjs";

const key = (value) => process.platform === "win32"
  ? path.resolve(value).toLowerCase() : path.resolve(value);
const sameClosure = (closure, entry) => Boolean(closure &&
  closure.sha256 === entry.directoryClosureSha256 &&
  closure.entryCount === entry.directoryClosureEntryCount);
async function statOrNull(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/**
 * Retire only reviewed install entries with an exact, unchanged ownership
 * receipt. Uses the existing manifest/CAS transaction; no second ownership
 * ledger, project scan, same-name user deletion or upstream uninstall script.
 */
export async function retireAbsorbedDependencyCopies({
  repoRoot, homes, targets = Object.keys(homes ?? {}), dryRun = false,
  writeBoundary = createInstallerWriteBoundary({ runtimeHomes: Object.values(homes ?? {}) }),
  recorderFactory = openRecorder,
} = {}) {
  const contract = JSON.parse(await fs.readFile(
    path.join(repoRoot, "config/contracts/dependency-absorption-contract.json"), "utf8"));
  const retired = (contract.currentReview?.items ?? [])
    .filter((item) => item.decision === "absorbed_install_retired" && item.managedCopyRetirement?.enabled === true);
  const manifest = readManifest(manifestPathFor("global"));
  const recorder = manifest ? recorderFactory({ scope: "global", requireExistingValidManifest: true }) : null;
  const plans = [], preserved = [], absent = [];
  const seenTargets = new Set();
  const selected = [...new Set(targets)].filter((runtime) => homes?.[runtime]);
  for (const item of retired) {
    const policy = item.managedCopyRetirement;
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(item.id) || policy.relativePath !== `skills/${item.id}` ||
        policy.policy !== "exact_manifest_owned_unchanged_closure_only" ||
        policy.ownershipSource !== "install-global-skills-all-runtimes" ||
        policy.ownershipPurpose !== `${item.id}-global-skill`) {
      throw new Error(`Invalid retired dependency ownership contract: ${item.id}`);
    }
    for (const runtime of selected.filter((id) => policy.targets.includes(id))) {
      const target = path.join(homes[runtime], "skills", item.id);
      if (seenTargets.has(key(target))) continue;
      seenTargets.add(key(target));
      const describe = { id: item.id, runtime, path: target };
      try { assertInstallerWritePath(target, writeBoundary); }
      catch { preserved.push({ ...describe, reason: "unsafe_or_redirected_path" }); continue; }
      const stat = await statOrNull(target);
      if (!stat) { absent.push(describe); continue; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        preserved.push({ ...describe, reason: "not_plain_directory" }); continue;
      }
      const matching = (manifest?.entries ?? []).filter((entry) => key(entry.path) === key(target));
      const entry = matching.length === 1 ? matching[0] : null;
      if (!entry || entry.kind !== "dir" || entry.category !== "A" ||
          entry.source !== policy.ownershipSource || entry.purpose !== policy.ownershipPurpose ||
          (entry.ownershipClass && entry.ownershipClass !== "install_projection")) {
        preserved.push({ ...describe, reason: "exact_install_ownership_missing" }); continue;
      }
      if (!sameClosure(directoryClosureSync(target), entry)) {
        preserved.push({ ...describe, reason: "owned_content_changed" }); continue;
      }
      plans.push({ ...describe, entry, stagedPath: null });
    }
  }
  if (dryRun || plans.length === 0) {
    return { removed: [], planned: plans.map(({ entry, stagedPath, ...record }) => record), preserved, absent,
      dryRun, manifestChanged: false };
  }
  const staged = [];
  try {
    for (const plan of plans) {
      assertInstallerWritePath(plan.path, writeBoundary);
      if (!sameClosure(directoryClosureSync(plan.path), plan.entry)) {
        throw new Error(`Retired dependency changed before transaction: ${plan.id}`);
      }
      plan.stagedPath = path.join(path.dirname(plan.path), `.meta-kim-retire-${plan.id}-${randomUUID()}`);
      assertInstallerWritePath(plan.stagedPath, writeBoundary);
      await fs.rename(plan.path, plan.stagedPath);
      staged.push(plan);
      if (!sameClosure(directoryClosureSync(plan.stagedPath), plan.entry)) {
        throw new Error(`Retired dependency changed during transaction: ${plan.id}`);
      }
      recorder.forget(plan.path, plan.entry.purpose);
    }
    const result = await recorder.flush();
    if (!result.ok) throw new Error(`Retired dependency manifest update failed: ${result.error}`);
  } catch (error) {
    for (const plan of staged.reverse()) {
      if (await statOrNull(plan.path)) {
        throw new Error(`${error.message}; rollback preserved staged content at ${plan.stagedPath}`);
      }
      await fs.rename(plan.stagedPath, plan.path);
    }
    throw error;
  }
  for (const plan of staged) await fs.rm(plan.stagedPath, { recursive: true });
  return { removed: plans.map(({ entry, stagedPath, ...record }) => record), planned: [], preserved, absent,
    dryRun: false, manifestChanged: true };
}
