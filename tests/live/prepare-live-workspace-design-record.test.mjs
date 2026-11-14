import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { prepareLiveWorkspaceDesignRecord } from "../../src/application/live/prepare-live-workspace-design-record.mjs";
import { loadLiveWorkspacePolicy } from "../../src/application/live/live-workspace-policy.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
function input() {
  return { artifact: { runId: "published-design-run", recordOrigin: "acceptance_fixture",
    productDesignPacket: { designDigest: "a".repeat(64), softwareDesign: {
      architecture: { id: "system", summary: "Actual architecture" },
      modules: [{ id: "alpha", purpose: "Actual module", implementationNotes: "Read the original contract" }] },
    taskSlices: [{ privateExecutionDetails: "not a design material" }] }, unrelatedHistory: "not copied" },
  options: { profile: "default", source: { ref: ".meta-kim/state/default/governed-executions/published-design-run.json",
    sha256: "b".repeat(64), bytes: 42000000, identity: { dev: "1", ino: "2", size: "42000000", mtimeNs: "3", ctimeNs: "4" } } } };
}

test("private workspace design preparation preserves source identity and only the displayed software contract", () => {
  const { artifact, options } = input();
  const result = prepareLiveWorkspaceDesignRecord(artifact, options);
  assert.equal(result.sha256, sha(result.content));
  assert.equal(result.bytes, Buffer.byteLength(result.content));
  assert.deepEqual(result.projection.design, { softwareDesign: artifact.productDesignPacket.softwareDesign });
  assert.deepEqual(result.projection.source, options.source);
  assert.equal(result.projection.sourceDesignDigest, artifact.productDesignPacket.designDigest);
  assert.equal(result.projection.softwareDesignSha256, sha(JSON.stringify(artifact.productDesignPacket.softwareDesign)));
  assert.equal(result.projection.recordOrigin, "acceptance_fixture");
  assert.equal(result.projection.nativeInvocationVerified, false);
  assert.equal(result.projection.completionVerified, false);
  assert.equal(result.projection.publicReadyAuthority, false);
  assert.ok(!result.content.includes("privateExecutionDetails"));
  assert.ok(!result.content.includes("unrelatedHistory"));
  artifact.productDesignPacket.softwareDesign.modules[0].purpose = "Later mutation";
  assert.equal(result.projection.design.softwareDesign.modules[0].purpose, "Actual module");
  assert.equal(prepareLiveWorkspaceDesignRecord({ runId: "without-design" }, {}), null);
});

test("private workspace design preparation binds exact source run/profile and retains both byte budgets", () => {
  for (const change of [value => { value.options.source.ref = "other.json"; },
    value => { value.options.profile = "another-profile"; }, value => { value.options.source.sha256 = "invalid"; },
    value => { value.options.source.identity.size = "1"; }]) {
    const value = input(); change(value);
    assert.throws(() => prepareLiveWorkspaceDesignRecord(value.artifact, value.options),
      { code: "workspace_design_projection_binding_invalid", status: 409 });
  }
  const { artifact, options } = input();
  assert.throws(() => prepareLiveWorkspaceDesignRecord(artifact, { ...options,
    policy: { ...loadLiveWorkspacePolicy(), maxDesignBytes: 100 } }), { code: "workspace_material_too_large", status: 413 });
  const softwareBytes = Buffer.byteLength(JSON.stringify(artifact.productDesignPacket.softwareDesign));
  assert.throws(() => prepareLiveWorkspaceDesignRecord(artifact, { ...options,
    policy: { ...loadLiveWorkspacePolicy(), maxDesignBytes: softwareBytes + 1 } }), { code: "workspace_material_too_large", status: 413 });
});
