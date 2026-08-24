import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_PUBLIC_REPLAY_SCHEMA_VERSION,
  LIVE_SHARE_ARTIFACT_SCHEMA_VERSION,
  assertValidLiveShareArtifact,
  buildLiveShareArtifact as buildDomainShareArtifact,
  canonicalShareDigest,
  verifyLiveShareArtifact,
} from "../../src/domain/live/live-share-artifact.mjs";
import { buildLiveShareArtifact } from "../../src/application/live/build-live-share-artifact.mjs";
import {
  renderLivePrCard,
  renderLiveReadmeEmbed,
  renderLiveShareCard,
} from "../../src/presentation/live/render-live-share-card.mjs";

const SNAPSHOT_SCHEMA = "meta-kim-live-snapshot-v1";

function snapshotFixture() {
  return {
    schemaVersion: SNAPSHOT_SCHEMA,
    source: {
      kind: "governed_artifact",
      observedAt: "2026-08-24T10:00:00.000Z",
      stale: false,
    },
    run: {
      runId: "meta-share-demo-1",
      status: "active",
      currentStage: "execution",
      updatedAt: "2026-08-24T09:59:00.000Z",
    },
    nodes: [
      {
        id: "stage:execution",
        label: "Execution",
        stage: "execution",
        status: "active",
        ownerAgent: "frontend-developer",
        runtime: "codex",
        summary: "Rendering the public proof card",
        evidenceCount: 1,
      },
      {
        id: "worker:tests-1",
        label: "Focused tests",
        stage: "verification",
        status: "completed",
        ownerAgent: "test",
        runtime: "codex",
        summary: "Bounded verification evidence is present",
        evidenceCount: 2,
      },
    ],
    edges: [{ from: "stage:execution", to: "worker:tests-1" }],
    evidence: [
      { id: "evidence:1", type: "verification", label: "Focused tests", status: "completed" },
    ],
    replay: [
      {
        sequence: 1,
        at: "2026-08-24T09:58:00.000Z",
        kind: "stage",
        nodeId: "stage:execution",
        status: "active",
        label: "Execution started",
        runId: "meta-share-demo-1",
      },
      {
        sequence: 2,
        at: "2026-08-24T09:59:00.000Z",
        kind: "verification",
        nodeId: "worker:tests-1",
        status: "completed",
        label: "Verification completed",
        runId: "meta-share-demo-1",
      },
    ],
    permissions: {
      projectionOnly: true,
      executionAllowed: false,
      mutationAllowed: false,
    },
  };
}

test("builds a deterministic content-bound public share artifact and replay schema", () => {
  const input = { snapshot: snapshotFixture() };
  const first = buildLiveShareArtifact(input);
  const second = buildLiveShareArtifact(structuredClone(input));

  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, LIVE_SHARE_ARTIFACT_SCHEMA_VERSION);
  assert.equal(first.replay.schemaVersion, LIVE_PUBLIC_REPLAY_SCHEMA_VERSION);
  assert.equal(first.replay.runId, "meta-share-demo-1");
  assert.match(first.contentDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(verifyLiveShareArtifact(first).valid, true);
  assert.equal(assertValidLiveShareArtifact(first), first);
  assert.equal(first.permissions.readOnly, true);
  assert.equal(first.permissions.executionAllowed, false);
  assert.equal(first.permissions.mutationAllowed, false);
  assert.equal(canonicalShareDigest({ ...first, contentDigest: undefined }), first.contentDigest);
});

test("does not trust a caller digest and detects payload tampering", () => {
  const artifact = buildDomainShareArtifact({ snapshot: snapshotFixture() });
  const forged = { ...artifact, contentDigest: "sha256:" + "0".repeat(64) };
  assert.equal(verifyLiveShareArtifact(forged).valid, false);

  const changed = { ...artifact, run: { ...artifact.run, status: "failed" } };
  assert.equal(verifyLiveShareArtifact(changed).valid, false);
  assert.throws(() => assertValidLiveShareArtifact(changed), /digest|binding|invalid/iu);
});

test("strictly removes secrets, paths, raw prompt/output/env and unsafe metadata", () => {
  const input = snapshotFixture();
  input.run.title = "raw prompt: do the private customer migration";
  input.nodes[0].summary = "output=/private/customer.json secret=super-secret token=ghp_0123456789abcdefghijklmnopqrstuvwxyz";
  input.nodes[0].env = { HOME: "C:\\Users\\Kim", API_KEY: "never-share" };
  input.evidence.push({
    id: "evidence:2",
    type: "raw_output",
    label: "stdout: /var/lib/private.json password=super-secret",
    status: "completed",
  });
  const artifact = buildLiveShareArtifact({ snapshot: input });
  const serialized = JSON.stringify(artifact);

  assert.doesNotMatch(serialized, /private customer migration|super-secret|ghp_0123456789|C:\\Users\\Kim|\/var\/lib\/private\.json/iu);
  assert.doesNotMatch(serialized, /raw_output|stdout|API_KEY|HOME|raw prompt|output=/iu);
  assert.match(serialized, /redacted|path omitted|unknown/iu);
});

test("fails closed for circular, oversized, malformed, and cross-run replay input", () => {
  const circular = snapshotFixture();
  circular.loop = circular;
  assert.throws(() => buildLiveShareArtifact({ snapshot: circular }), /circular|cycle|invalid/iu);

  const oversized = snapshotFixture();
  oversized.nodes[0].summary = "x".repeat(600_000);
  assert.throws(() => buildLiveShareArtifact({ snapshot: oversized }), /size|large|bounded|invalid/iu);

  assert.throws(() => buildLiveShareArtifact({ snapshot: { schemaVersion: SNAPSHOT_SCHEMA } }), /run|invalid/iu);
  const wrongRunReplay = snapshotFixture();
  wrongRunReplay.replay[0].runId = "meta-other-run";
  assert.throws(() => buildLiveShareArtifact({ snapshot: wrongRunReplay }), /run|replay|binding|invalid/iu);
});

test("renders only plain Markdown PR and README embed cards", () => {
  const artifact = buildLiveShareArtifact({ snapshot: snapshotFixture() });
  const pr = renderLiveShareCard(artifact);
  const prAlias = renderLivePrCard(artifact);
  const embed = renderLiveReadmeEmbed(artifact, { artifactPath: "docs/live/replay.json" });

  assert.equal(pr, prAlias);
  assert.match(pr, /Meta_Kim Live|Replay|sha256:/iu);
  assert.match(pr, /stage:execution|Focused tests/iu);
  assert.match(embed, /docs\/live\/replay\.json/iu);
  assert.doesNotMatch(`${pr}\n${embed}`, /<script|<iframe|<img|onerror|https?:\/\//iu);
  assert.doesNotMatch(`${pr}\n${embed}`, /C:\\|\/private\/|raw prompt|stdout|secret/iu);
});
test("escapes hostile titles and falls back from unsafe Markdown paths", () => {
  const artifact = buildLiveShareArtifact({ snapshot: snapshotFixture() });
  const pr = renderLiveShareCard(artifact, {
    title: "<img src=x onerror=alert(1)> [click](javascript:alert(1)) & injected",
  });
  const embed = renderLiveReadmeEmbed(artifact, {
    title: "<script>alert(1)</script>",
    artifactPath: "docs/(replay)&[latest].md",
  });

  assert.match(pr, /&lt;img/iu);
  assert.doesNotMatch(`${pr}\n${embed}`, /<img|<script|<iframe/iu);
  assert.doesNotMatch(embed, /docs\/\(replay\)&\[latest\]\.md/iu);
  assert.match(embed, /\.meta-kim\/live\/share-artifact\.json/iu);
});
