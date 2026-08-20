import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildBetaRuntimeAdapterBundlePlan,
  assertValidBetaRuntimeAdapterBundlePlan,
  BETA_RUNTIME_ADAPTER_BUNDLE_FILES,
} from "../../src/application/installer/beta-runtime-adapter-bundle.mjs";
import { verifyBetaRuntimeAdapterBundle } from "../../src/infrastructure/installer/beta-runtime-adapter-bundle.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SETUP_SOURCE = readFileSync(path.join(REPO_ROOT, "setup.mjs"), "utf8");

function makePackedBetaRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-beta-bundle-"));
  for (const entry of BETA_RUNTIME_ADAPTER_BUNDLE_FILES) {
    const source = path.join(REPO_ROOT, ...entry.path.split("/"));
    const target = path.join(root, ...entry.path.split("/"));
    cpSync(source, target, { recursive: false });
  }
  return root;
}

test("fresh install, update, and same-version reuse keep the beta bundle available but inactive", async () => {
  const root = makePackedBetaRoot();
  try {
    const installPlan = buildBetaRuntimeAdapterBundlePlan({ mode: "install" });
    const updatePlan = buildBetaRuntimeAdapterBundlePlan({ mode: "update" });
    assertValidBetaRuntimeAdapterBundlePlan(installPlan);
    assertValidBetaRuntimeAdapterBundlePlan(updatePlan);
    const fresh = await verifyBetaRuntimeAdapterBundle({
      packageRoot: root,
      plan: installPlan,
    });
    const updated = await verifyBetaRuntimeAdapterBundle({
      packageRoot: root,
      plan: updatePlan,
      expectedEntries: fresh.entries,
    });
    const sameVersion = await verifyBetaRuntimeAdapterBundle({
      packageRoot: root,
      plan: updatePlan,
      expectedEntries: updated.entries,
    });
    for (const report of [fresh, updated, sameVersion]) {
      assert.equal(report.status, "verified");
      assert.equal(report.available, true);
      assert.equal(report.activated, false);
      assert.equal(report.formalProjection, false);
      assert.equal(report.syncTarget, false);
      assert.equal(report.entries.length, 10);
    }
    assert.deepEqual(
      fresh.entries.map(({ path: entryPath }) => entryPath),
      updated.entries.map(({ path: entryPath }) => entryPath),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing or tampered beta assets fail closed before any activation", async () => {
  const root = makePackedBetaRoot();
  try {
    const plan = buildBetaRuntimeAdapterBundlePlan({ mode: "update" });
    const baseline = await verifyBetaRuntimeAdapterBundle({ packageRoot: root, plan });
    const missing = path.join(root, "config", "candidate-runtime-assets", "zcode", "CANDIDATE_PROBE.md");
    unlinkSync(missing);
    await assert.rejects(
      verifyBetaRuntimeAdapterBundle({
        packageRoot: root,
        plan,
        expectedEntries: baseline.entries,
      }),
      /missing|regular file|plain/u,
    );

    cpSync(path.join(REPO_ROOT, "config", "candidate-runtime-assets", "zcode", "CANDIDATE_PROBE.md"), missing);
    writeFileSync(missing, `${readFileSync(missing, "utf8")}\nTAMPERED\n`);
    await assert.rejects(
      verifyBetaRuntimeAdapterBundle({
        packageRoot: root,
        plan,
        expectedEntries: baseline.entries,
      }),
      /hash does not match/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup only orchestrates the beta check after stable handoff and never activates beta runtimes", () => {
  assert.match(SETUP_SOURCE, /ensureStableGlobalProjectionPackage\([\s\S]*?verifyBetaRuntimeAdapterBundleStep\("install"/u);
  assert.match(SETUP_SOURCE, /ensureStableGlobalProjectionPackage\([\s\S]*?verifyBetaRuntimeAdapterBundleStep\("update"/u);
  assert.match(SETUP_SOURCE, /available by default, inactive/u);
  assert.doesNotMatch(SETUP_SOURCE, /zcode.*(?:--yolo|--mode\s+(?:build|edit))/isu);
  assert.doesNotMatch(SETUP_SOURCE, /deepseek-harness.*(?:spawn|fetch|model)/isu);
});
