import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const execFileAsync = promisify(execFile);

async function runResearchExecution(repoRoot, { refresh = true, expectedExit = 0 } = {}) {
  let result;
  try { result = await execFileAsync(
    process.execPath,
    ["scripts/generate-research-execution-report.mjs", ...(refresh ? ["--refresh"] : [])],
    { cwd: repoRoot, encoding: "utf8", timeout: 120_000 },
  ); } catch (error) {
    if (error.code !== expectedExit) throw error;
    result = error;
  }
  assert.equal(result.code ?? 0, expectedExit, result.stderr);
  const { stdout } = result;
  const jsonStart = stdout.indexOf("{");
  assert.notEqual(jsonStart, -1, stdout);
  return JSON.parse(stdout.slice(jsonStart));
}

async function researchFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-research-http-fixture-"));
  // Product modules resolve inputs relative to their source tree. Copy them so
  // changing scenario URLs/cache never changes the checkout's production data.
  for (const dir of ["scripts", "canonical", "config", "src", "tests/meta-theory/scenarios"]) {
    cpSync(path.join(REPO_ROOT, dir), path.join(root, dir), { recursive: true });
  }
  cpSync(path.join(REPO_ROOT, "package.json"), path.join(root, "package.json"));
  const scenarioPath = path.join(root, "tests/meta-theory/scenarios/research-execution-cases.json");
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
  const sources = scenario.cases.filter((item) => item.url);
  const requests = [];
  let failHttp = false;
  const server = createServer((req, res) => {
    const source = sources.find((item) => req.url === `/${item.id}`);
    if (!source) { res.writeHead(404); res.end(); return; }
    requests.push(source.id);
    if (failHttp) { res.writeHead(503); res.end("fixture unavailable"); return; }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`LOCAL TEST FIXTURE: ${source.id}. ` + "Synthetic evidence for fetch/cache/freshness regression only. ".repeat(20));
  });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  for (const source of sources) {
    source.url = `http://127.0.0.1:${server.address().port}/${source.id}`;
    source.task = `Exercise local HTTP fixture for ${source.id}; no current external facts are attested.`;
    source.credibility = "local_test_fixture";
  }
  writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2));
  return { root, requests, sourceIds: sources.map(({ id }) => id), failHttp: () => { failHttp = true; } };
}

describe("44 — Research execution, freshness, and innovation sandbox", () => {
  test("P-047/P-048/P-049 fetch isolated HTTP sources, record freshness, and keep innovation candidate-only", async (t) => {
    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    assert.equal(
      packageJson.scripts["meta:research:execute"],
      "node scripts/generate-research-execution-report.mjs --refresh",
    );

    const contract = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "config/contracts/research-execution-contract.json"), "utf8"),
    );
    assert.equal(contract.schemaVersion, "research-execution-contract-v0.1");
    assert.ok(contract.requiredSourceCategories.includes("official_docs"));
    assert.ok(contract.requiredSourceCategories.includes("news_version"));
    assert.ok(contract.requiredSourceCategories.includes("third_party_tool"));
    assert.ok(contract.requiredResearchExecutionFields.includes("queryIterationCount"));
    assert.ok(contract.requiredResearchExecutionFields.includes("falsificationAttempt"));
    assert.ok(contract.iterationQualityGate.confidenceEnum.includes("high"));
    assert.equal(contract.innovationCandidatePacket.canonicalWritesMustEqual, 0);

    const fixture = await researchFixture(t);
    const summary = await runResearchExecution(fixture.root);
    assert.deepEqual(fixture.requests.sort(), fixture.sourceIds.sort(), "each permitted source must really be fetched over loopback HTTP");
    assert.equal(summary.ok, true);
    assert.equal(summary.caseCount, 6);
    assert.ok(summary.liveFetchCount >= 4);
    assert.ok(summary.blockedCount >= 2);
    assert.ok(summary.staleRefreshCount >= 1);
    assert.equal(summary.innovationCandidateCount, 2);
    assert.equal(summary.canonicalWrites, 0);

    const reportPath = path.join(fixture.root, summary.report);
    const markdownPath = path.join(fixture.root, summary.markdown);
    assert.equal(existsSync(reportPath), true);
    assert.equal(existsSync(markdownPath), true);

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.schemaVersion, "research-execution-report-v0.1");
    assert.equal(report.status, "pass");
    assert.equal(report.summary.allRequiredTypesCovered, true);
    assert.ok(report.summary.sourceTypes.includes("official_docs"));
    assert.ok(report.summary.sourceTypes.includes("news_version"));
    assert.ok(report.summary.sourceTypes.includes("third_party_tool"));
    assert.ok(report.summary.sourceTypes.includes("credential_blocked"));
    assert.ok(report.summary.sourceTypes.includes("network_blocked"));

    const livePackets = report.results
      .map((item) => item.researchExecutionPacket)
      .filter((packet) => ["fetched_live", "stale_refreshed"].includes(packet.executionStatus));
    assert.ok(livePackets.length >= 4);
    for (const packet of livePackets) {
      assert.equal(packet.preparationStatus, "prepared");
      assert.equal(packet.httpStatus, 200);
      assert.match(packet.sourceUrl ?? packet.url, /^http:\/\/127\.0\.0\.1:/u);
      assert.ok(packet.byteLength > 500);
      assert.match(packet.contentHash, /^[a-f0-9]{64}$/);
      assert.equal(packet.freshnessPolicy.state, "fresh");
      assert.ok(packet.queryIterationCount >= 1);
      assert.equal(packet.evidenceGapClosed, true);
      assert.notEqual(packet.confidenceBefore, packet.confidenceAfter);
      assert.equal(packet.falsificationAttempt.status, "tested_survived");
      assert.equal(packet.thinkingHandoff.readyForThinking, true);
      assert.ok(packet.decisionImpactMap.every((impact) => impact.changesThinkingRoute));
    }

    const blockedPackets = report.results
      .map((item) => item.researchExecutionPacket)
      .filter((packet) => packet.executionStatus === "blocked");
    assert.equal(blockedPackets.length, 2);
    assert.ok(blockedPackets.every((packet) => packet.thinkingHandoff.returnToStage === "Fetch"));
    assert.ok(blockedPackets.every((packet) => packet.evidenceGapClosed === false));
    assert.ok(blockedPackets.every((packet) => packet.falsificationAttempt.status === "blocked"));

    assert.ok(
      report.freshnessExamples.some((item) => item.state === "stale_refresh_required"),
      "freshness examples must show stale evidence returning to Fetch",
    );

    for (const item of report.innovationCandidates) {
      assert.equal(item.validation.status, "pass");
      assert.equal(item.candidate.schemaVersion, "innovation-candidate-packet-v0.1");
      assert.equal(item.candidate.canonicalWrites, 0);
      assert.equal(item.candidate.wardenApprovalRequirement, "required_before_any_canonical_write");
      assert.ok(item.candidate.alternativePaths.length >= 2);
      assert.ok(item.candidate.existingCapabilitiesChecked.length >= 6);
    }

    const markdown = readFileSync(markdownPath, "utf8");
    assert.match(markdown, /prepared research, live fetched evidence, stale evidence refresh/);
    assert.match(markdown, /iteration\/confidence updates/);
    assert.match(markdown, /canonical/i);

    // Exercise the real persisted cache. Only the deliberately stale source
    // should fetch again; cached evidence must not be counted as new live fetch.
    fixture.requests.length = 0;
    const cached = await runResearchExecution(fixture.root, { refresh: false, expectedExit: 1 });
    assert.equal(cached.liveFetchCount, 1);
    assert.equal(cached.ok, false, "a cache-heavy run is not a fresh live research pass");
    assert.deepEqual(fixture.requests, ["node-release-version-index"]);
    const cachedReport = JSON.parse(readFileSync(path.join(fixture.root, cached.report), "utf8"));
    assert.equal(cachedReport.results.filter((item) => item.researchExecutionPacket.executionStatus === "cache_hit").length, 3);

    // A real HTTP failure must fail closed, rather than relabel cached content
    // as fresh evidence. No production endpoint or credential is contacted.
    fixture.failHttp();
    await assert.rejects(runResearchExecution(fixture.root), /HTTP 503/u);

  });
});
