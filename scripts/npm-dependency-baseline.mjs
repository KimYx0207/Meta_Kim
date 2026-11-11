import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const canonical = value => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equalJson = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const resolvedIdentity = (value, root) => value.startsWith("file:")
  ? fileURLToPath(new URL(value, pathToFileURL(`${root}${path.sep}`))) : value;

/** Only an explicit source baseline digest permits a new locked dependency set. */
export function readReviewedNpmBaseline(packageRoot, manifest) {
  const configPath = path.join(packageRoot, "config/dependency-baseline.json");
  if (!existsSync(configPath)) return null;
  assert(lstatSync(configPath).isFile() && !lstatSync(configPath).isSymbolicLink(), "Dependency baseline must be a plain file");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!config.npm) return null;
  const review = config.npm;
  assert(config.schemaVersion === 1 && review.lockFile === "npm-shrinkwrap.json"
    && /^[a-f0-9]{64}$/u.test(review.sha256), "Invalid reviewed npm baseline");
  const lockPath = path.join(packageRoot, review.lockFile);
  assert(lstatSync(lockPath).isFile() && !lstatSync(lockPath).isSymbolicLink(), "Reviewed npm lock must be a plain file");
  const bytes = readFileSync(lockPath);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), review.sha256, "Reviewed npm lock differs from its baseline digest");
  const lock = JSON.parse(bytes);
  assert([2, 3].includes(lock.lockfileVersion) && lock.packages?.[""], "Reviewed npm lock requires an exact package inventory");
  assert.equal(lock.name, manifest.name, "Reviewed npm lock package name differs");
  assert.equal(lock.version, manifest.version, "Reviewed npm lock package version differs");
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "engines"]) {
    assert(equalJson(lock.packages[""][key] ?? {}, manifest[key] ?? {}), `Reviewed npm lock differs from package ${key}`);
  }
  const packages = Object.entries(lock.packages).filter(([relative]) => relative).map(([relative, record]) => {
    assert(relative.startsWith("node_modules/") && !relative.split("/").some(part => !part || [".", ".."].includes(part))
      && !relative.includes("\\") && !record.link && typeof record.version === "string"
      && typeof record.resolved === "string" && record.resolved
      && /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/u.test(record.integrity ?? ""),
    `Reviewed npm lock lacks a complete package identity: ${relative}`);
    return { path: relative, version: record.version, resolved: resolvedIdentity(record.resolved, packageRoot), integrity: record.integrity,
      optional: record.optional === true, dev: record.dev === true };
  });
  return { sha256: review.sha256, packages, lock, packageRoot: path.resolve(packageRoot) };
}

/**
 * npm versions differ in whether a local tarball's nested shrinkwrap controls
 * its dependency resolution. Make the reviewed identities the install root's
 * lock, so fresh installation uses npm ci without resolving those ranges again.
 * Only wrapper metadata and the real packed first-party identity are added;
 * every third-party version and integrity value comes from the reviewed lock.
 */
export function prepareReviewedNpmBundle(bundleRoot, manifest, archivePath, baseline) {
  assert(baseline?.lock?.packages?.[""], "A reviewed source lock is required");
  // npm install serializes local tarball identities relative to its root. Seed
  // that same representation so a later same-lock update preserves the exact
  // accepted lock identities as well as the installed dependency bytes.
  const localReference = file => `file:${path.relative(bundleRoot, file).split(path.sep).join("/")}`;
  const archive = localReference(path.resolve(archivePath));
  const wrapper = { name: "meta-kim-runtime-bundle", version: "1.0.0", private: true,
    dependencies: { [manifest.name]: archive } };
  if (manifest.overrides) wrapper.overrides = structuredClone(manifest.overrides);
  const packages = structuredClone(baseline.lock.packages);
  const firstParty = `node_modules/${manifest.name}`;
  assert(!Object.hasOwn(packages, firstParty), "Reviewed dependency lock contains the package itself");
  for (const record of Object.values(packages)) {
    if (record.resolved?.startsWith("file:")) {
      record.resolved = localReference(resolvedIdentity(record.resolved, baseline.packageRoot));
    }
  }
  packages[firstParty] = { ...packages[""], resolved: archive,
    integrity: `sha512-${createHash("sha512").update(readFileSync(archivePath)).digest("base64")}` };
  packages[""] = { name: wrapper.name, version: wrapper.version, dependencies: wrapper.dependencies };
  const lock = { name: wrapper.name, version: wrapper.version, lockfileVersion: 3, requires: true, packages };
  writeFileSync(path.join(bundleRoot, "package.json"), `${JSON.stringify(wrapper, null, 2)}\n`);
  writeFileSync(path.join(bundleRoot, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
}

/** Verify npm's real packed install against the reviewed lock, never against a prior unpinned tree. */
export function assertReviewedNpmInstall(bundleRoot, packageName, baseline) {
  if (!baseline) return;
  const lock = JSON.parse(readFileSync(path.join(bundleRoot, "package-lock.json"), "utf8"));
  const firstParty = `node_modules/${packageName}`;
  const actual = new Map();
  for (const [relative, record] of Object.entries(lock.packages ?? {})) {
    if (!relative || relative === firstParty) continue;
    const normalized = relative.startsWith(`${firstParty}/`) ? relative.slice(firstParty.length + 1) : relative;
    assert(!actual.has(normalized), `Reviewed npm install has ambiguous package layout: ${normalized}`);
    actual.set(normalized, { record, relative });
  }
  for (const expected of baseline.packages) {
    const item = actual.get(expected.path);
    if (!item && (expected.optional || expected.dev)) continue;
    assert(item, `Reviewed npm dependency was not installed: ${expected.path}`);
    for (const key of ["version", "resolved", "integrity"]) {
      const actualValue = key === "resolved" ? resolvedIdentity(item.record[key], bundleRoot) : item.record[key];
      assert.equal(actualValue, expected[key], `Installed npm ${expected.path} differs from reviewed ${key}`);
    }
    const manifest = JSON.parse(readFileSync(path.join(bundleRoot, item.relative, "package.json"), "utf8"));
    assert.equal(manifest.version, expected.version, `Installed npm manifest differs from reviewed version: ${expected.path}`);
    actual.delete(expected.path);
  }
  assert.equal(actual.size, 0, "Installed npm dependencies include packages outside the reviewed lock");
}
