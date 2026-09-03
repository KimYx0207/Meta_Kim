import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildGovernedArtifact,
  resolveFixture,
} from "../../src/application/live/live-acceptance-fixture-loader.mjs";
import {
  buildLiveCompactProjection,
  serializeLiveCompactProjection,
} from "../../src/application/live/live-control-room-service.mjs";
import {
  LIVE_ACCEPTANCE_FIXTURE_RECORD_ORIGIN,
  LIVE_DEFAULT_RECORD_ORIGIN,
  LIVE_RECORD_ORIGINS,
  liveRecordIsGovernedRun,
  liveRecordOrigin,
} from "../../src/application/live/live-record-origin.mjs";
import {
  FIXTURE_STATE_DIR_DEFAULT,
  resolveFixtureWriteTarget,
  targetIsRealRunStore,
} from "../../scripts/run-live-acceptance-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE_PATH = path.join(REPO_ROOT, "fixtures", "live-acceptance", "claude-code-real-run.json");

const FIXTURE_RUN_ID = "fixture-claude-code-acceptance";

async function loadFixture() {
  const raw = await readFile(FIXTURE_PATH, "utf8");
  return JSON.parse(raw);
}

function buildProjection(fixture, baseIso) {
  const resolved = resolveFixture(fixture, baseIso);
  const artifact = buildGovernedArtifact(resolved, FIXTURE_RUN_ID, baseIso);
  const projection = buildLiveCompactProjection(artifact);
  const serialized = serializeLiveCompactProjection(projection);
  const deserialized = JSON.parse(serialized);
  return { fixture, resolved, artifact, projection, serialized, deserialized };
}

test("P1.1 fixture resolves a verifiable conversation identity", async () => {
  const fixture = await loadFixture();
  const { projection } = buildProjection(fixture, "2026-08-31T01:00:00.000Z");
  const run = projection.run || {};
  const session = projection.session || {};
  assert.equal(run.conversationLinkState, "verified", "conversation identity must be verified");
  assert.equal(typeof run.conversationRef, "string", "conversationRef must be a non-empty string");
  assert.match(run.conversationRef, new RegExp(`^${fixture.meta.sessionIdPrefix}-${FIXTURE_RUN_ID}$`));
  assert.equal(session.runtime, fixture.meta.runtime);
  assert.equal(session.mode, "observed");
  assert.equal(session.proofState, "host evidence observed");
  assert.ok(Array.isArray(run.verifiedLinks) && run.verifiedLinks.length >= 1);
});

function nodeByOwner(fixture, projection) {
  const byWorker = new Map();
  for (const worker of fixture.workers) {
    const node = projection.nodes.find((candidate) => candidate.roleInstanceId === worker.roleInstanceId);
    if (node) byWorker.set(worker.id, node);
  }
  const main = projection.nodes.find((node) => node.isMain) || projection.nodes[0];
  if (main) byWorker.set("agent:main", main);
  return byWorker;
}

test("P1.1 fixture renders the required active/completed/pending/blocked mix", async () => {
  const fixture = await loadFixture();
  const { projection } = buildProjection(fixture, "2026-08-31T01:00:00.000Z");
  const statuses = projection.nodes.map((node) => node.status);
  const required = ["active", "completed", "pending", "blocked"];
  for (const state of required) {
    assert.ok(statuses.includes(state), `node status mix must include ${state}; got ${JSON.stringify(statuses)}`);
  }
  const completedNodes = projection.nodes.filter((node) => node.status === "completed");
  assert.ok(completedNodes.length >= 1, "at least one node must reach completed");
  const blockedNodes = projection.nodes.filter((node) => node.status === "blocked");
  assert.ok(blockedNodes.length >= 1, "PRD P1.1 must include a blocked node");
});

test("P1.1 fixture carries real execution edges (sequence + depends_on + contains)", async () => {
  const fixture = await loadFixture();
  const { projection } = buildProjection(fixture, "2026-08-31T01:00:00.000Z");
  const kinds = new Set(projection.edges.map((edge) => edge.kind));
  for (const kind of ["contains", "depends_on"]) {
    assert.ok(kinds.has(kind), `edges must include ${kind}; got ${JSON.stringify([...kinds])}`);
  }
  const nodeById = nodeByOwner(fixture, projection);
  const declared = fixture.edges.filter((edge) => edge.kind !== "contains");
  for (const edge of declared) {
    const fromNode = nodeById.get(edge.from);
    const toNode = nodeById.get(edge.to);
    assert.ok(fromNode, `edge.from must resolve to a projection node: ${edge.from}`);
    assert.ok(toNode, `edge.to must resolve to a projection node: ${edge.to}`);
    const matches = projection.edges.some(
      (projected) => projected.from === fromNode.id && projected.to === toNode.id,
    );
    assert.ok(matches, `fixture edge ${edge.from}→${edge.to} (${edge.kind}) must appear in projection.edges`);
  }
});

test("P1.1 fixture observed capability evidence covers skill/mcp/runtime_tool/command_script", async () => {
  const fixture = await loadFixture();
  const { projection } = buildProjection(fixture, "2026-08-31T01:00:00.000Z");
  const familiesObserved = new Set();
  for (const evidence of projection.evidence) {
    if (evidence?.proofValid === true && evidence?.synthetic !== true) {
      familiesObserved.add(evidence.evidenceKind);
    }
  }
  for (const family of ["skill", "mcp", "runtime_tool", "command_script"]) {
    assert.ok(familiesObserved.has(family), `observed evidence must include ${family}; got ${JSON.stringify([...familiesObserved])}`);
  }
});

test("P1.1 fixture preserves proofValid + non-synthetic contract on every observed row", async () => {
  const fixture = await loadFixture();
  const { projection } = buildProjection(fixture, "2026-08-31T01:00:00.000Z");
  for (const evidence of projection.evidence) {
    assert.equal(evidence.proofValid, true, `evidence row must be proofValid=true: ${JSON.stringify(evidence)}`);
    assert.notEqual(evidence.synthetic, true, `evidence row must not be synthetic: ${JSON.stringify(evidence)}`);
  }
  const toolCalls = projection.toolCalls || [];
  assert.ok(toolCalls.length >= 1, "at least one observed tool call must surface through toolCalls");
});

test("P1.1 fixture keeps the projection byte budget after serialisation", async () => {
  const fixture = await loadFixture();
  const { serialized, projection } = buildProjection(fixture, "2026-08-31T01:00:00.000Z");
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 256 * 1024, "serialised projection must fit Live 256KB budget");
  const counts = projection.counts || {};
  assert.ok(counts.nodes >= 4, "projection must contain the expected worker nodes plus main+workflow");
  assert.ok(counts.edges >= 1, "projection must contain at least one edge");
});

test("P1.1 fixture does not smuggle placeholder timestamps into the projection", async () => {
  const fixture = await loadFixture();
  const { serialized } = buildProjection(fixture, "2026-08-31T01:00:00.000Z");
  assert.equal(serialized.includes("{startBase"), false, "placeholder tokens must be resolved before write");
});

test("PRD increment: declared vs observed axis flags mismatch without downgrading status", async () => {
  const fixture = await loadFixture();
  const { projection } = buildProjection(fixture, "2026-08-31T01:00:00.000Z");
  const mismatchNode = projection.nodes.find((node) => node.roleInstanceId === "exec-mismatch-6");
  assert.ok(mismatchNode, "mismatch fixture worker must appear in projection");
  assert.equal(mismatchNode.declaredStatus, "completed");
  assert.notEqual(mismatchNode.observedStatus, mismatchNode.declaredStatus, "observed must disagree with declared status");
  assert.equal(mismatchNode.declaredObservedMismatch, true, "mismatch flag must be true");
  assert.equal(mismatchNode.status, "completed", "declared status is preserved alongside mismatch flag");
  const observedNodes = projection.nodes.filter((node) => typeof node.observedStatus === "string" || node.observedStatus === null);
  assert.ok(observedNodes.length >= 4, "every worker node must carry declaredStatus + observedStatus fields");
});

test("PRD increment: handoff edges connect same-component workers in time order", async () => {
  const fixture = await loadFixture();
  const { projection } = buildProjection(fixture, "2026-08-31T01:00:00.000Z");
  const handoffEdges = projection.edges.filter((edge) => edge.kind === "handoff");
  assert.ok(handoffEdges.length >= 1, "at least one handoff edge must surface");
  const handoff = handoffEdges[0];
  assert.equal(handoff.componentId, "comp:source-wiring");
  assert.equal(handoff.fromRoleInstance, "exec-read-source-1");
  assert.equal(handoff.toRoleInstance, "exec-read-source-5");
  const fromNode = projection.nodes.find((node) => node.id === handoff.from);
  const toNode = projection.nodes.find((node) => node.id === handoff.to);
  assert.ok(fromNode && toNode, "handoff endpoints must reference real projection nodes");
  assert.ok(typeof handoff.gapMs === "number" && handoff.gapMs >= 0);
});

test("PRD increment: worker fileHeat surfaces observed file paths in newest-first order", async () => {
  const fixture = await loadFixture();
  const { projection } = buildProjection(fixture, "2026-08-31T01:00:00.000Z");
  const readSource = projection.nodes.find((node) => node.roleInstanceId === "exec-read-source-1");
  assert.ok(readSource, "read-source worker must appear in projection");
  const paths = (readSource.fileHeat || []).map((entry) => entry.path);
  assert.ok(paths.includes("fixtures/live-acceptance/claude-code-real-run.json"), "fileHeat must include fixture path");
  assert.ok(paths.includes(".meta-kim/state/default/live-control-room-claude-handoff-prd.md"), "fileHeat must include PRD path");
  const atList = (readSource.fileHeat || []).map((entry) => Date.parse(entry.at));
  for (let index = 1; index < atList.length; index += 1) {
    assert.ok(atList[index - 1] >= atList[index], "fileHeat must be sorted newest-first");
  }
  const noFile = projection.nodes.find((node) => node.roleInstanceId === "exec-blocked-visual-4");
  assert.equal((noFile.fileHeat || []).length, 0, "nodes without observed file paths must have empty fileHeat");
});

/**
 * The fixture must never be readable as a real run.
 *
 * Measured on this repo before the stamp existed: of 44 catalogued rows, the only
 * two carrying worker counts and a resolved runtime were both fixtures, because a
 * fixture declares by construction what a real activation often has not produced
 * yet. Nothing in the written file said so, so they read as the two healthiest
 * records in the directory and sorted above every real run.
 *
 * The stamp belongs to the loader rather than to the CLI: the loader is the only
 * thing that turns a fixture into an artifact, so stamping there makes an
 * unmarked fixture artifact unrepresentable instead of depending on each caller
 * to remember. It is asserted after the serialise/parse round trip because the
 * file on disk, not the in-memory artifact, is what a reader receives.
 */
test("a fixture-built record declares itself a fixture all the way to disk", async () => {
  const fixture = await loadFixture();
  const { artifact, deserialized } = buildProjection(fixture, "2026-08-31T01:00:00.000Z");
  assert.ok(
    LIVE_RECORD_ORIGINS.includes(LIVE_ACCEPTANCE_FIXTURE_RECORD_ORIGIN),
    "the fixture origin must come from the shared vocabulary, or readers weigh a value nobody registered",
  );
  assert.notEqual(
    LIVE_ACCEPTANCE_FIXTURE_RECORD_ORIGIN,
    LIVE_DEFAULT_RECORD_ORIGIN,
    "a fixture that stamps the neutral default has stamped nothing",
  );
  assert.equal(artifact.recordOrigin, LIVE_ACCEPTANCE_FIXTURE_RECORD_ORIGIN);
  assert.equal(liveRecordOrigin(deserialized), LIVE_ACCEPTANCE_FIXTURE_RECORD_ORIGIN);
  assert.equal(
    liveRecordIsGovernedRun(deserialized),
    false,
    "the written file is the only thing a later reader has, so the stamp has to survive projection and serialisation",
  );
});

/**
 * Every `matchBasis` in a record, keyed by where it sits.
 *
 * Recursive rather than a lookup on the records emitted today, because what the
 * two tests below police is the field appearing where nothing earned it, and a new
 * nested conversation record is how it would appear next.
 */
function collectMatchBasis(record, rootLabel) {
  const found = [];
  const walk = (value, trail) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, `${trail}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "matchBasis") found.push(`${trail}.${key}=${JSON.stringify(child)}`);
      else walk(child, `${trail}.${key}`);
    }
  };
  walk(record, rootLabel);
  return found;
}

/**
 * The basis values alone, with the bucket path dropped.
 *
 * `collectMatchBasis` keys every entry by where it sits, which is what makes a
 * failure legible, but it also means two lists differ the moment the placement
 * differs. An assertion about the basis itself therefore has to compare values
 * only: a basis frozen to a constant still reads as "moved" if the record also
 * changed bucket.
 *
 * That is not hypothetical. Freezing the derived basis to a constant in
 * `live-control-room-service.mjs` left the path-keyed comparison below green - the
 * record had moved from `verifiedLinks` to `candidateLinks`, which was difference
 * enough - and only the literal after it failed.
 */
function basisValuesOnly(entries) {
  return entries.map((entry) => entry.slice(entry.indexOf("=") + 1));
}

/**
 * Provenance the fixture did not earn must not be stated at all.
 *
 * `matchBasis` answers "how do we know this run belongs to this chat", and the one
 * producer that can earn it - `canonical/runtime-assets/shared/hooks/conversation-binding.mjs`
 * - earns it from eight filesystem checks against the transcript the host named.
 * Nothing in the fixture path opens a transcript: the identifier is templated from
 * `fixture.meta.sessionIdPrefix`, so a basis written there is a claim the loader
 * manufactures about itself. The loader wrote `exact_metadata`.
 *
 * Asserted on the artifact, which is where the claim is made, because it is not
 * observable anywhere later. Readers fold a stored basis against a derived one
 * through `conversationMatchBasisFor`, and for this link the derivation is
 * `exact_run_id`, which out-ranks it. Measured: the record
 * `scripts/run-live-acceptance-fixture.mjs` serialises is identical in that field
 * with the claim and without it, so an assertion on the written record would hold
 * either way and would read later as a guard that had always been satisfied.
 *
 * What that fold hides it does not fix, and the claim has reached a reader: a record
 * this loader produced earlier the same day names `exact_metadata` on both
 * `run.verifiedLinks` and `session.verifiedLinks`, so some revision between the
 * loader and those two arrays did carry it through.
 *
 * The walk is recursive rather than a lookup on the two records the loader emits
 * today, because what is being prevented is the field appearing at all, and a new
 * nested conversation record is how it would appear next.
 */
test("a fixture-built record states no conversation provenance it did not earn", async () => {
  const fixture = await loadFixture();
  const { artifact } = buildProjection(fixture, "2026-08-31T01:00:00.000Z");

  const claimed = collectMatchBasis(artifact, "artifact");

  assert.ok(
    Array.isArray(artifact.conversationLinks) && artifact.conversationLinks.length >= 1,
    "with no conversation record in the artifact the walk inspects nothing and the assertion below passes for free",
  );
  assert.ok(
    artifact.sourceConversation && typeof artifact.sourceConversation === "object",
    "the loader's second conversation record has to exist for the walk to have covered it",
  );
  assert.deepEqual(
    claimed,
    [],
    "the loader stated a conversation provenance nothing in its path can earn, at the path listed above",
  );
});

/**
 * The written record may state a basis, but only one its own facts produce.
 *
 * The test above stops the loader from manufacturing the claim. It cannot see the
 * same synthesis moved one layer down: if projection or serialisation ever supplies
 * a value for a basis the artifact left absent, that test stays green while the
 * file on disk names a provenance again.
 *
 * "No basis on disk" is the wrong shape for that. Measured: the written record
 * legitimately carries two - `run.verifiedLinks[0]` and `session.verifiedLinks[0]`,
 * both `exact_run_id` - because the record's own conversation link names this run,
 * and a reader derives that rather than reading it back. Asserting the field is
 * absent there would fail on correct behaviour.
 *
 * So the pair is asserted instead: the basis a record earns, and the different basis
 * it earns once nothing in it names this run any more. A constant supplied downstream
 * satisfies the first and breaks the second, so the second branch is what keeps the
 * first from being vacuous - a value that never moves is not derived.
 *
 * Both branches override both conversation records, but measured, only
 * `sourceConversation` moves the result: the link and the source record carry the same
 * `conversationRef`, so they dedupe to one entry and the source record's verdict is the
 * one written. A link naming a foreign run next to a matching source record changes
 * nothing in the written file.
 */
test("a written record's conversation provenance tracks the record's own facts", async () => {
  const fixture = await loadFixture();
  const { artifact, deserialized } = buildProjection(fixture, "2026-08-31T01:00:00.000Z");
  const writeOf = (record) => JSON.parse(serializeLiveCompactProjection(buildLiveCompactProjection(record)));

  const FOREIGN_RUN_ID = "some-other-run";
  const disownedWrite = writeOf({
    ...artifact,
    conversationLinks: artifact.conversationLinks.map((link) => ({ ...link, runId: FOREIGN_RUN_ID })),
    sourceConversation: { ...artifact.sourceConversation, runId: FOREIGN_RUN_ID },
  });

  const earned = collectMatchBasis(deserialized, "written");
  const disowned = collectMatchBasis(disownedWrite, "written");

  assert.notEqual(
    FOREIGN_RUN_ID,
    FIXTURE_RUN_ID,
    "the second branch has to name a run this record does not, or both branches measure the same thing",
  );
  assert.deepEqual(
    earned,
    [
      'written.run.verifiedLinks[0].matchBasis="exact_run_id"',
      'written.session.verifiedLinks[0].matchBasis="exact_run_id"',
    ],
    "the written record states a conversation basis other than the one its own runId earns",
  );
  assert.notDeepEqual(
    basisValuesOnly(disowned),
    basisValuesOnly(earned),
    "the written basis did not move when the record stopped naming this run, so it is a value supplied downstream rather than one the record earns",
  );
  assert.deepEqual(
    disowned,
    [
      'written.run.candidateLinks[0].matchBasis="foreign_run_metadata_candidate"',
      'written.session.candidateLinks[0].matchBasis="foreign_run_metadata_candidate"',
    ],
    "a record naming a foreign run has to land in the candidate bucket under its own basis, not vanish and not stay verified",
  );
});

/**
 * Where the fixture is allowed to land.
 *
 * The stamp makes a fixture honest; it does not stop one from accumulating in the
 * directory that holds real history, where it is counted, retained and offered as
 * a default. The writer therefore defaults to an ignored scratch directory, and
 * the store the hub actually reads requires an explicit opt-in.
 *
 * The predicate is written against the three read paths that exist in this repo -
 * `live-read-repository.mjs`, `live-hub-project-catalog.mjs` and
 * `live-run-retention-store.mjs` - all of which end in `governed-executions`
 * inside a `.meta-kim` tree, at two different depths.
 */
test("the fixture writer cannot land in a real run store unless it is asked to", () => {
  for (const real of [
    ".meta-kim/state/default/governed-executions",
    ".meta-kim/state/some-other-profile/governed-executions",
    ".meta-kim/governed-executions",
  ]) {
    assert.equal(
      targetIsRealRunStore(path.resolve(REPO_ROOT, real)),
      true,
      `${real} is a directory the hub reads run history from`,
    );
  }
  for (const isolated of [FIXTURE_STATE_DIR_DEFAULT, "tmp/live-acceptance/governed-executions"]) {
    assert.equal(
      targetIsRealRunStore(path.resolve(REPO_ROOT, isolated)),
      false,
      `${isolated} holds no real history, so writing there needs no permission`,
    );
  }
  assert.equal(
    targetIsRealRunStore(path.resolve(REPO_ROOT, FIXTURE_STATE_DIR_DEFAULT)),
    false,
    "the default target is the one nobody sets deliberately, so it is the one that has to be safe",
  );

  const refused = resolveFixtureWriteTarget({
    stateDir: ".meta-kim/state/default/governed-executions",
    cwd: REPO_ROOT,
  });
  assert.equal(refused.targetDir, null, "a refusal must yield no path at all, or a caller writes anyway");
  assert.match(
    refused.refusal,
    /LIVE_ALLOW_PROJECT_STATE/u,
    "the refusal has to name the opt-in, otherwise the only way past it is to edit the script",
  );
  const allowed = resolveFixtureWriteTarget({
    stateDir: ".meta-kim/state/default/governed-executions",
    allowProjectState: true,
    cwd: REPO_ROOT,
  });
  assert.equal(allowed.refusal, null);
  assert.equal(allowed.targetDir, path.resolve(REPO_ROOT, ".meta-kim/state/default/governed-executions"));
  const defaulted = resolveFixtureWriteTarget({ cwd: REPO_ROOT });
  assert.equal(defaulted.refusal, null);
  assert.equal(defaulted.targetDir, path.resolve(REPO_ROOT, FIXTURE_STATE_DIR_DEFAULT));
});
