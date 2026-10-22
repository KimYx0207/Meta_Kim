import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectLiveDeliverables, publicLiveDeliverable, readLiveDeliverable } from "../../src/application/live/live-deliverables.mjs";
import { buildLiveCompactProjection, buildLiveSnapshot, createLiveControlRoomService } from "../../src/application/live/live-control-room-service.mjs";
import { createLiveControlRoomServer } from "../../src/infrastructure/live/live-control-room-server.mjs";
import { LIVE_MAX_JSON_BYTES } from "../../src/infrastructure/live/live-read-repository.mjs";

const runId = "live-deliverable-fixture";
const taskPacketId = "task-backend-fixture";
function artifact(overrides = {}) {
  return { schemaVersion: 1, runId, recordOrigin: "acceptance_fixture", status: "partial", updatedAt: new Date().toISOString(),
    executionResult: { actualWorkerExecution: true }, workerTaskPackets: [{ taskPacketId, roleDisplayName: "backend", ownerAgent: "backend" }],
    workerResultPackets: [{ runId, taskPacketId, ownerAgent: "backend", status: "executed", resultKind: "native_read_only_worker_result",
      output: { text: "The actual bounded result <script>parent.fixtureScriptRan=true</script>" }, producedArtifacts: ["outputs/page.html", "outputs/readme.md"],
      workerExecutionEvidence: [{ runId, taskPacketId, status: "executed", runtimeProcessInvoked: true, synthetic: false }] }], ...overrides };
}

test("executed, task-verified, and unbound historical claims stay distinct across compact round-trip", () => {
  const raw = artifact();
  raw.workerResultPackets[0].workerExecutionEvidence.unshift({ runId, taskPacketId, status: "pending_execution", evidenceKind: "structural_worker_plan", observedResult: "not_run_by_governed_runner" });
  const compact = buildLiveCompactProjection(raw);
  for (const input of [raw, compact]) {
    const snapshot = buildLiveSnapshot({ governedArtifact: input });
    const worker = snapshot.nodes.find((node) => node.isMain === false && node.kind === "agent");
    assert.equal(worker.status, "in_doubt");
    assert.equal(worker.executionState, "executed");
    assert.equal(snapshot.run.executionEvidenceState, "recorded", "obsolete verify-step placeholders cannot hide an actual observed return");
    assert.match(worker.statusReason, /等待任务验证/u);
    assert.equal(snapshot.deliverables.length, 3);
    assert.equal(snapshot.deliverables[0].taskPacketId, worker.taskPacketId);
    assert.doesNotMatch(JSON.stringify(snapshot.deliverables), /outputs\/|actual bounded|parent.secret/u);
  }
  const verified = artifact();
  const result = verified.workerResultPackets[0];
  result.status = "completed";
  result.workerExecutionEvidence = [{ runId, taskPacketId, status: "verified", command: "node --check bounded-result.mjs", runBy: "backend",
    runAt: new Date().toISOString(), commandRanAt: new Date().toISOString(), observedResult: "exit code 0", successMarkerFormat: "exit-code-only", exitCode: 0 }];
  assert.equal(buildLiveSnapshot({ governedArtifact: verified }).nodes.find((node) => node.roleDisplayName === "backend").status, "completed");
  delete result.workerExecutionEvidence[0].runId;
  assert.equal(buildLiveSnapshot({ governedArtifact: verified }).nodes.find((node) => node.roleDisplayName === "backend").status, "in_doubt");
  result.workerExecutionEvidence[0].runId = runId;
  delete result.workerExecutionEvidence[0].commandRanAt;
  assert.equal(buildLiveSnapshot({ governedArtifact: verified }).nodes.find((node) => node.roleDisplayName === "backend").status, "in_doubt");
  for (const successMarkerFormat of ["stdout-text", "json-output"]) {
    result.workerExecutionEvidence[0] = { runId, taskPacketId, status: "verified", command: "fixture-check", runBy: "backend", runAt: new Date().toISOString(),
      successMarkerFormat, observedResult: "test failed", actualOutput: successMarkerFormat === "json-output" ? '{"status":"failed"}' : "not ok 1", exitCode: 1 };
    assert.equal(buildLiveSnapshot({ governedArtifact: verified }).nodes.find((node) => node.roleDisplayName === "backend").status, "in_doubt", `${successMarkerFormat} cannot override nonzero exit`);
    result.workerExecutionEvidence[0].exitCode = 0;
    result.workerExecutionEvidence[0].resultStatus = "failed";
    assert.equal(buildLiveSnapshot({ governedArtifact: verified }).nodes.find((node) => node.roleDisplayName === "backend").status, "in_doubt", `${successMarkerFormat} cannot override explicit failure`);
  }
});

test("completion aliases cannot hide failure fields in raw or compact evidence", () => {
  const failures = [{ exitCode: 1 }, { resultStatus: "failed" }, { result: "error" }, { outcomeStatus: "failed" },
    { observedResult: { status: "failed" } }, { passed: false }, { success: false }];
  for (const status of ["completed", "success", "succeeded", "pass", "passed", "done", "verified"]) {
    for (const failure of failures) {
      const raw = artifact();
      raw.workerResultPackets[0].status = "completed";
      raw.workerResultPackets[0].workerExecutionEvidence = [{ runId, taskPacketId, status, command: "fixture-check", runBy: "backend",
        runAt: new Date().toISOString(), commandRanAt: new Date().toISOString(), actualOutput: "not ok", observedResult: "check returned", successMarkerFormat: "stdout-text", exitCode: 0, ...failure }];
      const compact = buildLiveCompactProjection(raw);
      for (const input of [raw, compact]) {
        const snapshot = buildLiveSnapshot({ governedArtifact: input });
        assert.equal(snapshot.nodes.find((node) => node.roleDisplayName === "backend").status, "in_doubt", `${status} + ${JSON.stringify(failure)} must not become completed`);
      }
    }
  }
  const failed = artifact();
  failed.workerResultPackets[0].status = "failed";
  failed.workerResultPackets[0].workerExecutionEvidence = [{ runId, taskPacketId, status: "failed", exitCode: 1, passed: false }];
  for (const input of [failed, buildLiveCompactProjection(failed)]) {
    assert.equal(buildLiveSnapshot({ governedArtifact: input }).nodes.find((node) => node.roleDisplayName === "backend").status, "failed");
  }
  const declared = artifact();
  declared.workerResultPackets[0].status = "completed";
  declared.workerResultPackets[0].workerExecutionEvidence = [{ runId, taskPacketId, status: "completed" }];
  const stored = buildLiveCompactProjection(declared);
  const worker = stored.nodes.find((node) => node.roleDisplayName === "backend");
  worker.workerExecutionEvidence[0].exitCode = 1;
  worker.terminalEvidence[0].exitCode = 1;
  assert.equal(buildLiveSnapshot({ governedArtifact: stored }).nodes.find((node) => node.roleDisplayName === "backend").status, "in_doubt", "stored compact evidence must reject its own explicit failure too");
});

test("declared deliverable reads are exact, output-only, bounded, and reject symlinks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-deliverable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "outputs"));
  await writeFile(path.join(root, "outputs/page.html"), "<h1>Fixture result</h1><script>fetch('/api/snapshot')</script>");
  await writeFile(path.join(root, "outputs/readme.md"), "# Actual fixture markdown");
  const raw = artifact();
  const refs = collectLiveDeliverables(raw);
  assert.deepEqual(refs.slice(0, 2).map((item) => item.label), ["page.html", "readme.md"]);
  assert.equal((await readLiveDeliverable(raw, refs[0].id, root)).kind, "html");
  assert.equal(await readLiveDeliverable(raw, "deliverable:" + "0".repeat(24), root), null);
  await writeFile(path.join(root, "outputs/too-large.txt"), "x".repeat(LIVE_MAX_JSON_BYTES + 1));
  const large = artifact({ primaryDeliverable: "outputs/too-large.txt" });
  assert.equal(await readLiveDeliverable(large, collectLiveDeliverables(large)[0].id, root), null);
  assert.equal(collectLiveDeliverables(artifact({ workerResultPackets: [{ ...raw.workerResultPackets[0], status: "planned_not_executed" }] })).length, 0);
  for (const ownerAgent of ["foreign-owner", null, undefined]) {
    const foreign = artifact({ workerResultPackets: [{ ...raw.workerResultPackets[0], ownerAgent }] });
    assert.equal(collectLiveDeliverables(foreign).length, 0, "a matching task id cannot transfer another owner's output");
    assert.equal(await readLiveDeliverable(foreign, refs[0].id, root), null);
  }
  for (const ref of ["../private.md", "outputs/../private.md", "src/private.md", "outputs/.env.md", "file:///private.md", "https://example.com/?token=bad", "javascript:alert(1)"]) {
    assert.equal(collectLiveDeliverables(artifact({ primaryDeliverable: ref })).some((item) => item.taskPacketId === null), false, ref);
  }
  const outside = await mkdtemp(path.join(os.tmpdir(), "live-deliverable-private-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "private.md"), "PRIVATE");
  try { await symlink(outside, path.join(root, "outputs/escape"), "junction"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.diagnostic("symlink unavailable for this host"); return; } throw error; }
  const linked = artifact({ primaryDeliverable: "outputs/escape/private.md" });
  assert.equal(await readLiveDeliverable(linked, collectLiveDeliverables(linked)[0].id, root), null);
});

test("a persisted compact reference reopens only its exact same-run source companion", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-deliverable-compact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "outputs"));
  const records = path.join(root, ".meta-kim/state/default/governed-executions");
  await mkdir(records, { recursive: true });
  await writeFile(path.join(root, "outputs/page.html"), "<h1>Persisted exact result</h1>");
  const raw = artifact();
  await writeFile(path.join(records, `${runId}.json`), JSON.stringify(raw));
  await writeFile(path.join(records, `${runId}.live.json`), JSON.stringify(buildLiveCompactProjection(raw)));
  const service = createLiveControlRoomService({ projectRoot: root });
  const snapshot = await service.getSnapshot(runId);
  assert.equal(snapshot.source.kind, "live_projection");
  assert.equal((await service.getDeliverable(runId, snapshot.deliverables[0].id)).text, "<h1>Persisted exact result</h1>");
  await writeFile(path.join(records, `${runId}.json`), JSON.stringify({ ...raw, runId: "foreign-run" }));
  assert.equal(await service.getDeliverable(runId, snapshot.deliverables[0].id), null);
});

test("HTTP opening is read-only, sandboxed, run-bound, and absent from public shares", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-deliverable-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "outputs"));
  await writeFile(path.join(root, "outputs/page.html"), "<h1>Actual fixture</h1><script>window.fixtureScriptRan=true</script>");
  await writeFile(path.join(root, "outputs/readme.md"), "# Fixture markdown");
  const raw = artifact();
  const service = createLiveControlRoomService({ repository: { projectRoot: root, readArtifact: async (id) => id === runId ? raw : null, readLatestArtifact: async () => raw } });
  const control = createLiveControlRoomServer({ service, port: 0 });
  t.after(() => control.close());
  const address = await control.start();
  const snapshot = await (await fetch(`${address.url}/api/snapshot?runId=${runId}`)).json();
  const url = `${address.url}/api/deliverable?runId=${runId}&deliverableId=${snapshot.deliverables[0].id}`;
  const html = await fetch(url);
  assert.equal(html.status, 200);
  const firstVersion = "sha256:" + createHash("sha256").update("<h1>Actual fixture</h1><script>window.fixtureScriptRan=true</script>").digest("hex");
  assert.equal(html.headers.get("x-meta-kim-content-version"), firstVersion);
  const spoofedVersion = "sha256:" + "f".repeat(64);
  const spoofed = await fetch(url, { headers: { "x-meta-kim-content-version": spoofedVersion } });
  assert.equal(spoofed.headers.get("x-meta-kim-content-version"), firstVersion, "a request header cannot provide content-read truth");
  const queryClaim = await fetch(url + "&contentVersion=" + spoofedVersion);
  assert.equal(queryClaim.status, 400);
  assert.equal(queryClaim.headers.get("x-meta-kim-content-version"), null);
  assert.equal(snapshot.deliverables[0].contentVersion, null, "a path declaration has not read file contents");
  assert.match(html.headers.get("content-security-policy"), /sandbox; default-src 'none'; script-src 'none'/u);
  assert.match(await html.text(), /Actual fixture/u);
  assert.equal((await fetch(url + "&path=outputs/page.html")).status, 400);
  assert.equal((await fetch(url.replace(runId, "foreign-run"))).status, 404);
  assert.equal((await fetch(url.replace(runId, "foreign-run"))).headers.get("x-meta-kim-content-version"), null);
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
  const textRef = snapshot.deliverables.find((item) => item.kind === "text");
  const textResponse = await fetch(`${address.url}/api/deliverable?runId=${runId}&deliverableId=${textRef.id}`);
  assert.match(await textResponse.text(), /&lt;script&gt;/u);
  const share = await service.getShare({ runId });
  assert.doesNotMatch(JSON.stringify(share), /deliverable:|outputs\/page|actual bounded|parent.secret/u);
  await writeFile(path.join(root, "outputs/page.html"), "<h1>Changed version</h1>");
  const changed = await service.getDeliverable(runId, snapshot.deliverables[0].id);
  assert.notEqual(changed.contentVersion, firstVersion);
  assert.equal(changed.contentVersion, "sha256:" + createHash("sha256").update(changed.text).digest("hex"));
  assert.equal(publicLiveDeliverable({ ...collectLiveDeliverables(raw)[0], contentVersion: firstVersion }).contentVersion, null, "a claimed hash on a descriptor is not observed content");
  raw.workerResultPackets[0].producedArtifacts.push("https://example.com/public-result");
  const external = collectLiveDeliverables(raw).find((item) => item.kind === "external");
  const externalResponse = await fetch(`${address.url}/api/deliverable?runId=${runId}&deliverableId=${external.id}`);
  assert.equal(externalResponse.status, 200);
  assert.equal(externalResponse.headers.get("x-meta-kim-content-version"), null, "rendering an external reference has not read its remote content");
});

test("revision records match exact identity while self-described command fields remain execution-unconfirmed", () => {
  const raw = artifact();
  const target = collectLiveDeliverables(raw).find((item) => item.text !== undefined);
  const version = publicLiveDeliverable(target, (id) => id, { contentObserved: true }).contentVersion;
  const now = "2026-10-22T08:00:00.000Z";
  const revision = { runId, findingId: "F-1", actionId: "A-1", taskPacketId, deliverableId: target.id, contentVersion: version, updatedAt: "2026-10-22T07:59:58.000Z", responseSummary: "outputs/private.md", fixArtifact: "C:/private/key" };
  raw.reviewPacket = { findings: [{ runId, findingId: "F-1", taskPacketId, summary: "<script>private</script>", fixArtifact: "C:/private/key" }] };
  raw.revisionResponses = [revision];
  const check = { ...revision, status: "verified", command: "node --check fixture.mjs", runBy: "backend", runAt: now, commandRanAt: now, observedResult: "exit code 0", successMarkerFormat: "exit-code-only", exitCode: 0 };
  raw.verificationPacket = { verificationResults: [check] };
  const project = () => buildLiveSnapshot({ governedArtifact: raw, observedAt: now }).revisionReview;
  assert.equal(project().items[0].state, "verification_unconfirmed");
  assert.equal(project().items[0].verificationObservedAt, null);
  assert.doesNotMatch(JSON.stringify(project()), /private|fixture\.mjs|script|fixArtifact/u);
  for (const mutation of [{ runId: "other" }, { taskPacketId: "other" }, { actionId: "other" }, { contentVersion: "sha256:" + "f".repeat(64) }, { deliverableId: "other" }]) {
    raw.verificationPacket.verificationResults = [{ ...check, ...mutation }];
    assert.equal(project().items[0].state, "pending_verification");
  }
  for (const mutation of [{ status: "passed", proofValid: true }, { command: undefined }, { exitCode: 1 }, { synthetic: true }, { evidenceKind: "structural" }, { commandRanAt: "2026-10-21T00:00:00.000Z" }, { runAt: "2026-10-22T09:00:00.000Z" }]) {
    raw.verificationPacket.verificationResults = [{ ...check, ...mutation }];
    assert.equal(project().items[0].state, "verification_unconfirmed");
  }
  raw.verificationPacket.verificationResults = [check];
  const compact = buildLiveCompactProjection(raw);
  assert.equal(buildLiveSnapshot({ governedArtifact: compact, observedAt: now }).revisionReview.items[0].state, "verification_unconfirmed", "stored summaries cannot self-attest a passed check");
  raw.revisionResponses = [{ ...revision, contentVersion: "sha256:" + "a".repeat(64) }];
  assert.equal(project().items[0].state, "pending_verification");
  delete raw.revisionResponses;
  raw.verificationPacket = { revisionResponses: [revision], verificationResults: [check] };
  assert.equal(project().items[0].state, "verification_unconfirmed", "existing verificationPacket records remain visible without self-attesting execution");
});

test("revision verification cannot skip a known finding or an explicit revision response", () => {
  const raw = artifact();
  const target = collectLiveDeliverables(raw).find((item) => item.text !== undefined);
  const contentVersion = publicLiveDeliverable(target, (id) => id, { contentObserved: true }).contentVersion;
  const now = "2026-10-22T08:00:00.000Z";
  const revision = { runId, findingId: "F-chain", actionId: "A-chain", taskPacketId, deliverableId: target.id, contentVersion };
  const check = { ...revision, status: "verified", command: "node --check fixture.mjs", runBy: "backend", runAt: now, commandRanAt: now, observedResult: "exit code 0", successMarkerFormat: "exit-code-only", exitCode: 0 };
  raw.reviewPacket = { findings: [] };
  raw.revisionResponses = [revision];
  raw.verificationPacket = { verificationResults: [check] };
  const project = () => buildLiveSnapshot({ governedArtifact: raw, observedAt: now }).revisionReview;
  assert.equal(project().items[0].state, "verification_unconfirmed", "an unknown finding cannot close a revision chain");
  raw.reviewPacket.findings = [{ ...revision, summary: "Known finding" }];
  assert.equal(project().items[0].state, "verification_unconfirmed", "the complete known chain retains its recheck record without attesting execution");
  delete raw.revisionResponses;
  assert.equal(project().items[0].state, "recorded", "a finding plus check cannot invent the missing revision response");
  raw.verificationPacket.revisionResponses = [revision];
  assert.equal(project().items[0].state, "verification_unconfirmed");
});

function reviewRegressionCase() {
  const raw = artifact();
  const target = collectLiveDeliverables(raw).find((item) => item.text !== undefined);
  const contentVersion = publicLiveDeliverable(target, (id) => id, { contentObserved: true }).contentVersion;
  const now = "2026-10-22T08:00:00.000Z";
  const revision = { runId, findingId: "F-review", actionId: "A-review", taskPacketId, deliverableId: target.id, contentVersion };
  const check = { ...revision, status: "verified", command: "node never-executed.mjs", runBy: "backend", runAt: now, commandRanAt: now, observedResult: "claimed exit code 0", successMarkerFormat: "exit-code-only", exitCode: 0 };
  raw.reviewPacket = { findings: [{ ...revision, summary: "Original finding" }] };
  raw.revisionResponses = [revision];
  raw.verificationPacket = { verificationResults: [check] };
  return { raw, target, revision, check, now, project: () => buildLiveSnapshot({ governedArtifact: raw, observedAt: now }).revisionReview };
}

test("review regression C1 self-described never-executed command cannot verify a revision", () => {
  const f = reviewRegressionCase();
  assert.equal(f.project().items[0].state, "verification_unconfirmed");
  f.raw.verificationPacket.verificationResults = [{ ...f.check, exitCode: undefined, successMarkerFormat: "stdout-text", actualOutput: "FAIL: validation failed" }];
  assert.equal(f.project().items[0].state, "verification_unconfirmed");
});

for (const field of ["actionId", "actionIds", "taskPacketId", "deliverableId"]) test("review regression C2 conflicting finding " + field + " cannot be overwritten by response", () => {
  const f = reviewRegressionCase();
  const foreignValue = field === "taskPacketId" ? "other-task" : field === "deliverableId" ? collectLiveDeliverables(f.raw).find((item) => item.kind === "html").id : "other-action";
  if (field === "taskPacketId") f.raw.workerTaskPackets.push({ taskPacketId: foreignValue, ownerAgent: "backend" });
  if (field === "actionIds") { delete f.raw.reviewPacket.findings[0].actionId; f.raw.reviewPacket.findings[0].actionIds = [f.revision.actionId]; }
  const responseField = field === "actionIds" ? "actionId" : field;
  f.raw.revisionResponses = [{ ...f.revision, [responseField]: foreignValue }];
  f.raw.verificationPacket.verificationResults = [{ ...f.check, [responseField]: foreignValue }];
  const items = f.project().items;
  assert.equal(items.length, 1);
  assert.equal(items[0].state, "recorded", "the original finding remains visible while the conflicting response/check is isolated");
  assert.equal(items[0].deliverableId, f.target.id);
});

test("review regression C4 real file recheck stays visible without claiming current content or execution truth", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-revision-file-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "outputs"));
  const file = path.join(root, "outputs/page.html");
  await writeFile(file, "<h1>Actual file revision</h1>");
  const f = reviewRegressionCase();
  const target = collectLiveDeliverables(f.raw).find((item) => item.kind === "html");
  const actualRead = await readLiveDeliverable(f.raw, target.id, root);
  const binding = { deliverableId: target.id, contentVersion: actualRead.contentVersion };
  f.raw.reviewPacket.findings = [{ ...f.revision, ...binding, contentVersion: "sha256:" + "a".repeat(64) }];
  f.raw.revisionResponses = [{ ...f.revision, ...binding }];
  f.raw.verificationPacket.verificationResults = [{ ...f.check, ...binding }];
  assert.equal(f.project().items[0].state, "verification_unconfirmed");
  await writeFile(file, "<h1>A later unreviewed file revision</h1>");
  assert.notEqual((await readLiveDeliverable(f.raw, target.id, root)).contentVersion, actualRead.contentVersion);
  assert.equal(f.project().items[0].state, "verification_unconfirmed");
  await rm(file);
  assert.equal(await readLiveDeliverable(f.raw, target.id, root), null);
  assert.equal(f.project().items[0].state, "verification_unconfirmed");
});

test("review regression C2 missing optional identity fields and a legitimate new version remain compatible", () => {
  const f = reviewRegressionCase();
  f.raw.reviewPacket.findings = [{ runId, findingId: f.revision.findingId, taskPacketId, contentVersion: "sha256:" + "a".repeat(64) }];
  assert.equal(f.project().items[0].state, "verification_unconfirmed", "the original finding hash is not the revised content hash");
  f.raw.reviewPacket.findings[0] = { ...f.revision, contentVersion: "sha256:" + "a".repeat(64), actionIds: [f.revision.actionId, "another-allowed-action"] };
  assert.equal(f.project().items[0].state, "verification_unconfirmed");
  f.raw.revisionResponses = [{ ...f.revision, actionId: undefined, taskPacketId: undefined, deliverableId: undefined }];
  assert.equal(f.project().items[0].state, "verification_unconfirmed", "missing optional bindings are not explicit conflicts");
});
