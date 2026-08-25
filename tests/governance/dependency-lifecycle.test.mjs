import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOwnershipReceipt,
  classifyDependencyLifecycle,
  lifecycleRouteEligibility,
} from "../../scripts/dependency-lifecycle.mjs";

const DIGEST = "a".repeat(64);

test("reference providers stay reference-only even when a local copy exists", () => {
  assert.equal(classifyDependencyLifecycle({
    providerId: "docs-only",
    isReference: true,
    isAvailable: true,
  }), "reference_only");
  assert.equal(lifecycleRouteEligibility({
    lifecycleState: "reference_only",
    declaredRouteEligibility: "callable",
  }), "reference_only");
});

test("path presence is available, while an exact managed closure proves installed", () => {
  assert.equal(classifyDependencyLifecycle({
    providerId: "provider",
    isAvailable: true,
  }), "available_not_installed");
  const receipt = buildOwnershipReceipt({
    manifest: { metaKimVersion: "3.0.3" },
    entry: {
      category: "A",
      kind: "dir",
      source: "install-global-skills-all-runtimes",
      purpose: "provider-global-skill",
      directoryClosureSha256: DIGEST,
      directoryClosureEntryCount: 3,
    },
    runtime: "codex",
    path: "C:/Users/test/.codex/skills/provider",
    userHome: "C:/Users/test",
  });
  assert.equal(receipt.digest, DIGEST);
  assert.equal(receipt.revision, DIGEST);
  assert.equal(receipt.runtime, "codex");
  assert.equal(receipt.ownership, "install_projection");
  assert.equal(receipt.ownershipReceipt.path, "~/.codex/skills/provider");
  assert.equal(classifyDependencyLifecycle({
    providerId: "provider",
    isAvailable: true,
    managedReceipt: receipt,
  }), "installed_provider");
});

test("active-for-run requires explicit run-bound evidence matching the managed digest", () => {
  const receipt = { digest: DIGEST };
  assert.equal(classifyDependencyLifecycle({
    providerId: "provider",
    managedReceipt: receipt,
    activeEvidence: { explicit: true, runId: "run-1", providerId: "other", receiptDigest: DIGEST },
  }), "installed_provider");
  assert.equal(classifyDependencyLifecycle({
    providerId: "provider",
    managedReceipt: receipt,
    activeEvidence: { explicit: true, runId: "run-1", providerId: "provider", receiptDigest: DIGEST },
  }), "active_for_run");
});
