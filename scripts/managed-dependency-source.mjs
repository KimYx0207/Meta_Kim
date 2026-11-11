import assert from "node:assert/strict";
import { promises as fs, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { directoryClosureSync, readManifest, openRecorder, CATEGORIES } from "./install-manifest.mjs";
import { inspectTrustedPath } from "./safe-managed-file-operations.mjs";
import { withFileLock } from "../canonical/runtime-assets/shared/hooks/spine-state-utils.mjs";
import { checkedPath, componentHash, stableJson, sha256 } from "../src/infrastructure/capabilities/source-integrity.mjs";

const PURPOSE = "kim-service-dependency-source";
const SOURCE = "install-global-skills-all-runtimes";
const REVISION_FILE = "source-revision.json";
const storeRelative = ".meta-kim/runtime/dependency-projects/kim-service";
const equalPath = (left, right) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;

function checkedStore(home, { allowMissing = false } = {}) {
  const physicalHome = realpathSync(home);
  const checked = inspectTrustedPath(physicalHome, storeRelative, { allowMissing });
  assert(checked, "Managed Service source store has an unsafe path");
  return { home: physicalHome, store: checked.target };
}

/** Only an unchanged source owned by the existing install ledger is discoverable. */
export function readManagedServiceSource({ home = os.homedir() } = {}) {
  const physicalHome = realpathSync(home);
  const manifestPath = inspectTrustedPath(physicalHome, ".meta-kim/install-manifest.json", { allowMissing: true });
  assert(manifestPath, "Managed Service install manifest has an unsafe path");
  const manifest = readManifest(manifestPath.target);
  assert(!existsSync(manifestPath.target) || manifest, "Managed Service install manifest is invalid");
  const entries = (manifest?.entries ?? []).filter(entry => entry.source === SOURCE && entry.purpose === PURPOSE && entry.kind === "dir");
  if (!entries.length) return null;
  const entry = entries.reverse().sort((a, b) => String(b.installedAt).localeCompare(String(a.installedAt)))[0];
  const { store } = checkedStore(home);
  assert(typeof entry.path === "string" && path.isAbsolute(entry.path), "Managed Service source must be absolute");
  assert(/^[a-f0-9]{64}$/u.test(path.basename(entry.path)) && equalPath(path.dirname(entry.path), store), "Managed Service source is outside its store");
  assert(inspectTrustedPath(store, path.basename(entry.path)), "Managed Service source has an unsafe path");
  const closure = directoryClosureSync(entry.path);
  assert(closure && closure.sha256 === entry.directoryClosureSha256 && closure.entryCount === entry.directoryClosureEntryCount,
    "Managed Service source differs from its installation receipt");
  const revisionPath = path.join(entry.path, REVISION_FILE);
  const revision = existsSync(revisionPath) ? JSON.parse(readFileSync(revisionPath, "utf8")) : null;
  return { value: entry.path, source: "install-manifest.json#kim-service-dependency-source", revision };
}

/** Explicit declarations keep precedence, including invalid/empty declarations. */
export function dependencyRootBinding(project, localOverrides, environment = process.env) {
  const envName = project.interface.capabilityIndex.rootEnv;
  if (envName && Object.hasOwn(environment, envName)) return { value: environment[envName], source: `environment:${envName}` };
  if (Object.hasOwn(localOverrides.dependencyRoots ?? {}, project.id)) return {
    value: localOverrides.dependencyRoots[project.id], source: `.meta-kim/local.overrides.json#dependencyRoots.${project.id}`,
  };
  if (project.source?.localPath != null) return { value: project.source.localPath, source: `dependency-project-registry.json#${project.id}.source.localPath` };
  const home = (process.platform === "win32" ? environment.USERPROFILE || environment.HOME : environment.HOME)
    || (environment === process.env ? os.homedir() : null);
  if (project.id === "kim-service" && home) {
    try {
      const managed = readManagedServiceSource({ home });
      if (managed) return managed;
    } catch (error) {
      return { value: null, source: "install-manifest.json#kim-service-dependency-source", error: error.message };
    }
  }
  return { value: null, source: `dependency-project-registry.json#${project.id}.source.localPath` };
}

async function copyPlain(source, destination) {
  const stat = await fs.lstat(source);
  assert(!stat.isSymbolicLink(), "Service source cannot contain symlinks or junctions");
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const name of await fs.readdir(source)) await copyPlain(path.join(source, name), path.join(destination, name));
  } else {
    assert(stat.isFile(), "Service source can contain only regular files and directories");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
}

async function verifyComponents(root, index) {
  for (const component of index.components) {
    const directory = await checkedPath(root, component.path, true);
    const contractPath = await checkedPath(directory, "capability.json");
    const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
    assert.equal(contract.schemaVersion, 1, "Invalid Service component contract");
    for (const key of ["id", "componentType", "componentVersion", "entrypoint"]) {
      assert.equal(component[key], contract[key], `Service index differs from component contract: ${key}`);
    }
    assert.equal(sha256(stableJson(contract)), component.contractSha256, "Service component contract hash mismatch");
    assert.equal(await componentHash(directory), component.contentSha256, "Service component content hash mismatch");
    await checkedPath(directory, contract.entrypoint);
    assert(Array.isArray(contract.capabilities), "Service component capabilities are required");
    assert.deepEqual([...component.capabilityIds].sort(), contract.capabilities.map(capability => capability.id).sort(), "Service capability IDs differ from contract");
    for (const capability of contract.capabilities) {
      const expected = { ...capability, componentId: contract.id, componentType: contract.componentType,
        componentVersion: contract.componentVersion, componentPath: component.path, entrypoint: contract.entrypoint,
        componentContentSha256: component.contentSha256, contractSha256: component.contractSha256 };
      const indexed = index.capabilities.find(value => value.id === capability.id);
      assert(indexed, "Service indexed capability is missing");
      // v1 deliberately omits optional adapter metadata; the full contract hash
      // still binds that metadata without granting it execution permission.
      for (const key of ["id", "summary", "useWhen", "doNotUseWhen", "input", "output", "permissions", "sideEffects", "humanGate", "validation",
        "componentId", "componentType", "componentVersion", "componentPath", "entrypoint", "componentContentSha256", "contractSha256"]) {
        assert.deepEqual(indexed[key], expected[key], `Service capability index differs from contract: ${key}`);
      }
      for (const [key, value] of Object.entries(indexed)) assert.deepEqual(value, expected[key], `Service capability index has unbound metadata: ${key}`);
    }
  }
  assert.equal(index.components.reduce((count, component) => count + component.capabilityIds.length, 0), index.capabilities.length, "Service capability index contains extra records");
}

/** Materialize indexed component closures, never private checkout files or .git. */
export async function materializeManagedServiceSource({ sourceRoot, home = os.homedir(), metaKimVersion, sourceRevision = null }) {
  assert((await fs.lstat(sourceRoot)).isDirectory() && !(await fs.lstat(sourceRoot)).isSymbolicLink(), "Service source must be a plain directory");
  const source = await fs.realpath(sourceRoot);
  const revision = sourceRevision ?? { schemaVersion: 1, selection: "local_override", repository: null, commit: null };
  if (sourceRevision) {
    assert(revision.schemaVersion === 1 && revision.selection === "reviewed_commit"
      && typeof revision.repository === "string" && /^[a-f0-9]{40}$/u.test(revision.commit), "Invalid Service source revision");
    const head = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
    assert.equal(head, revision.commit, "Service source revision differs from the checkout");
    const changes = execFileSync("git", ["-C", source, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", windowsHide: true }).trim();
    assert.equal(changes, "", "Reviewed Service checkout has local changes; use an explicit local source instead");
  }
  assert(inspectTrustedPath(source, "generated/capabilities.json"), "Unsafe Service capability index path");
  const indexBytes = await fs.readFile(path.join(source, "generated/capabilities.json"));
  const index = JSON.parse(indexBytes.toString("utf8"));
  assert(index.schemaVersion === 1 && Array.isArray(index.components) && Array.isArray(index.capabilities)
    && index.componentCount === index.components.length && index.capabilityCount === index.capabilities.length, "Invalid Service capability index");
  const components = index.components.map(component => {
    assert(typeof component.path === "string" && /^(?:agents|skills|hooks|tools|apps)\/[a-z0-9][a-z0-9._-]*$/iu.test(component.path), "Invalid Service component path");
    return component.path;
  });
  assert(new Set(components).size === components.length, "Duplicate Service component path");
  for (const records of [index.components, index.capabilities]) {
    assert(records.every(record => typeof record.id === "string" && record.id.trim()), "Service index IDs are required");
    assert.equal(new Set(records.map(record => record.id)).size, records.length, "Duplicate Service index ID");
  }
  await verifyComponents(source, index);
  const { home: physicalHome, store } = checkedStore(home, { allowMissing: true });
  assert(equalPath(physicalHome, realpathSync(os.homedir())), "Service source installation must use the current install home");
  await fs.mkdir(store, { recursive: true });
  return withFileLock(path.join(store, ".install.lock"), async () => {
    const staged = await fs.mkdtemp(path.join(store, ".staged-"));
    try {
      for (const relative of components) {
        assert(inspectTrustedPath(source, relative), "Unsafe Service component path");
        const before = directoryClosureSync(path.join(source, relative));
        assert(before, "Unreadable Service component");
        await copyPlain(path.join(source, relative), path.join(staged, relative));
        const copied = directoryClosureSync(path.join(staged, relative));
        assert(copied?.sha256 === before.sha256 && directoryClosureSync(path.join(source, relative))?.sha256 === before.sha256,
          "Service component changed during installation");
      }
      await fs.mkdir(path.join(staged, "generated"));
      await fs.writeFile(path.join(staged, "generated/capabilities.json"), indexBytes);
      await fs.writeFile(path.join(staged, REVISION_FILE), `${JSON.stringify(revision, null, 2)}\n`);
      for (const relative of ["VERSION", "LICENSE", "NOTICE", "catalog.json"]) {
        if (existsSync(path.join(source, relative))) await copyPlain(path.join(source, relative), path.join(staged, relative));
      }
      assert((await fs.readFile(path.join(source, "generated/capabilities.json"))).equals(indexBytes), "Service index changed during installation");
      await verifyComponents(staged, index);
      const closure = directoryClosureSync(staged);
      assert(closure, "Cannot hash managed Service source");
      const target = path.join(store, closure.sha256);
      if (existsSync(target)) {
        const manifest = readManifest(path.join(physicalHome, ".meta-kim/install-manifest.json"));
        const receipt = manifest?.entries.find(entry => entry.path === target && entry.source === SOURCE && entry.purpose === PURPOSE);
        assert(receipt && !lstatSync(target).isSymbolicLink() && directoryClosureSync(target)?.sha256 === closure.sha256,
          "Existing Service source is unowned or changed; preserved without replacement");
        if (readManagedServiceSource({ home: physicalHome })?.value === target) return target;
      } else {
        await fs.rename(staged, target);
      }
      const recorder = openRecorder({ scope: "global", metaKimVersion });
      recorder.recordDir(target, { source: SOURCE, purpose: PURPOSE, category: CATEGORIES.I });
      const result = await recorder.flush();
      assert(result.ok, `Service source receipt flush failed: ${result.error}`);
      return target;
    } finally {
      await fs.rm(staged, { recursive: true, force: true });
    }
  });
}
