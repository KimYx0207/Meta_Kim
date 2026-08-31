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