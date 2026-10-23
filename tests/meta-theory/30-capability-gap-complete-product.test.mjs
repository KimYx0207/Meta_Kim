import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
let runtimeFixture, COMPLETE_PRODUCT_INPUTS, runCapabilityGapCompleteProduct, sanitizeProductReportValue;
before(async () => {
  runtimeFixture = createGovernanceRuntimeFixtureScope(null, { graph: true });
  ({ COMPLETE_PRODUCT_INPUTS, runCapabilityGapCompleteProduct, sanitizeProductReportValue } =
    await runtimeFixture.import("scripts/run-capability-gap-complete-product.mjs"));
});
after(() => runtimeFixture?.cleanup());

const sourceLeakPattern = new RegExp(
  [
    "gst" + "ack",
    "gbr" + "ain",
    "wsh" + "obson",
    "Anth" + "ropic",
    "skill-" + "creator",
    "(?:^|[^A-Za-z])[A-Z]:[\\\\/]",
    "Users[\\\\/]Kim",
  ].join("|"),
  "i"
);
const sensitivePathFragmentPattern =
  /Private\s*Clients|Acme|credentials\.json|corp-server|finance|secret\.xlsx|\/srv\/private|\/app\/secrets|\/nix\/store|\/builds\/|token\.txt/i;

describe("30 — Capability Gap complete product MVP", () => {
  test("runs the complete-product entry with 12 real inputs, graph, feedback, analytics, and acceptance", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-complete-product-"));
    try {
      const jsonPath = path.join(tempDir, "complete-product.json");
      const markdownPath = path.join(tempDir, "complete-product.md");
      const dbPath = path.join(tempDir, "complete-product.sqlite");
      const report = await runCapabilityGapCompleteProduct({
        jsonPath,
        markdownPath,
        dbPath,
      });

      assert.equal(report.status, "pass");
      assert.equal(report.summary.inputs, 12);
      assert.equal(report.summary.decisionsCovered, 6);
      assert.equal(report.summary.scorecardsPassed, 12);
      assert.equal(report.summary.naturalInferenceWithoutExpectedDecision, true);
      assert.equal(report.summary.frPassRate, 1);
      assert.equal(report.summary.quantitativePassRate, 1);
      assert.deepEqual(
        report.productArtifacts.map((artifact) => artifact.gapDecision.decision),
        COMPLETE_PRODUCT_INPUTS.map((item) => item.expectedDecision)
      );

      for (const id of [
        "R-001",
        "R-002",
        "R-003",
        "R-004",
        "R-005",
        "R-006",
        "R-007",
        "R-008",
        "R-009",
        "R-010",
        "R-011",
      ]) {
        const check = report.requirementChecks.find((item) => item.id === id);
        assert.ok(check, `${id} check missing`);
        assert.equal(check.passed, true, `${id} must pass`);
        assert.ok(check.owner, `${id} must name owner`);
        assert.ok(check.returnToStage, `${id} must name returnToStage`);
      }

      for (const scorecard of report.scorecards) {
        assert.equal(scorecard.status, "pass");
        for (const dimension of [
          "completeness",
          "boundary_fit",
          "verification_readiness",
          "least_privilege",
          "reuse_or_run_scope_fit",
        ]) {
          assert.equal(scorecard.dimensions[dimension], true, `${dimension} must pass`);
        }
      }

      assert.equal(report.graphValidation.status, "pass");
      assert.equal(report.graphValidation.conditionalEdgeCount, 6);
      assert.equal(report.graphValidation.branchExecutionCoverage, 6);
      assert.equal(report.graphValidation.databaseAsPlannerCount, 0);
      assert.equal(report.graphValidation.directCanonicalWriteFromGraphNode, 0);
      assert.equal(report.governedExecutionEvidence.status, "partial");
      const { requirementsExploration, boundedPlanning } = report.governedExecutionEvidence;
      for (const slots of [["agent"], ["skill"], ["command"], ["mcpServer", "mcpTool"]]) {
        assert.ok(slots.some((slot) => requirementsExploration.discoveredSlots.includes(slot)));
      }
      assert.ok(requirementsExploration.incompleteWorkOrders > 0);
      assert.equal(requirementsExploration.safeForParallelFanout, false);
      assert.equal(requirementsExploration.actualWorkerExecution, false);
      assert.equal(requirementsExploration.publicReady, false);
      assert.equal(boundedPlanning.workerTaskPackets.length, 4);
      assert.ok(boundedPlanning.workerTaskPackets.every((packet) => packet.workOrderReadiness === "ready"));
      assert.equal(boundedPlanning.safeForParallelFanout, true);
      assert.equal(boundedPlanning.actualWorkerExecution, false);
      assert.equal(boundedPlanning.publicReady, false);
      assert.ok(boundedPlanning.workerResultPackets.every((packet) => packet.status === "planned_not_executed"));
      assert.equal(
        report.governedExecutionEvidence.defaultRuntimePath.entry,
        "meta:theory:run"
      );
      assert.equal(report.governedExecutionEvidence.runtimeProjectionEvidence.results.length, 4);
      assert.equal(
        report.governedExecutionEvidence.approvedWriteback.status,
        "approved-for-writeback"
      );
      assert.equal(report.governedExecutionEvidence.noRealCanonicalPollution, true);

      assert.equal(report.feedbackReplay.cases.length, 6);
      assert.equal(report.feedbackReplay.reductionPercent, 30);
      assert.equal(
        report.feedbackReplay.correctionInfluence.decisionChangedByCorrection,
        true
      );
      assert.notEqual(
        report.feedbackReplay.correctionInfluence.baselineDecision,
        report.feedbackReplay.correctionInfluence.correctedDecision
      );
      assert.equal(report.feedbackReplay.correctionInfluence.correctedDecision, "create_skill");
      assert.ok(
        report.feedbackReplay.correctionInfluence.replayedUserCorrections.length > 0
      );
      assert.ok(
        report.feedbackReplay.promotionCandidates.some(
          (item) =>
            item.repeatCount >= 3 &&
            item.status === "promotion_review_candidate" &&
            item.noAutomaticCanonicalWrite === true
        )
      );

      assert.equal(report.analytics.source, "RunStateStore");
      assert.equal(report.analytics.metricCount, 6);
      assert.equal(report.analytics.decisionDistribution.length, 6);
      assert.ok(report.analytics.userCorrectionDistribution.length >= 2);
      assert.ok(report.analytics.candidateAcceptance.length >= 2);
      assert.ok(report.analytics.repeatKeyTopList.length > 0);
      assert.ok(report.analytics.ownerFailureRate.length > 0);
      assert.ok(
        report.analytics.ownerFailureRate.every(
          (item) => typeof item.failureRate === "number"
        )
      );

      assert.equal(report.aiReadableStandards.status, "pass");
      assert.equal(report.aiReadableStandards.audience, "external product reviewer and AI reviewer");
      assert.deepEqual(
        report.aiReadableStandards.standards.map((standard) => standard.id),
        ["design", "execution", "acceptance", "feedback", "deliverables"]
      );
      for (const standard of report.aiReadableStandards.standards) {
        assert.equal(standard.status, "pass", `${standard.id} standard must pass`);
        assert.ok(standard.plainLanguageQuestion);
        assert.ok(standard.passStandard);
        assert.ok(standard.failStandard);
        assert.ok(standard.requiredEvidence.length > 0);
      }

      const r006 = report.requirementChecks.find((item) => item.id === "R-006");
      assert.match(r006.evidence, /auditableChecks=true/);
      assert.doesNotMatch(r006.evidence, /本命令输出 status/);

      for (const artifact of report.productArtifacts) {
        for (const field of [
          "criticalSummary",
          "fetchEvidence",
          "gapDecision",
          "decisionOutput",
          "reviewResult",
          "verificationResult",
          "feedbackPlaceholder",
          "evolutionDecision",
        ]) {
          assert.ok(artifact[field], `artifact missing ${field}`);
        }
      }

      assert.equal(
        report.governedExecutionEvidence.defaultRuntimePath.projectCustomizationPacket
          .execution.projectRoot,
        "<project-root>"
      );
      assert.equal(
        report.governedExecutionEvidence.defaultRuntimePath.visibleMetaTheorySurfacePacket
          .projectCustomization.execution.projectRoot,
        "<project-root>"
      );
      assert.doesNotMatch(JSON.stringify(report), sourceLeakPattern);

      const markdown = await readFile(markdownPath, "utf8");
      assert.match(markdown, /Capability Gap Complete Product MVP Report/);
      assert.match(markdown, /R-006/);
      assert.match(markdown, /R-011/);
      assert.match(markdown, /AI 可读标准/);
      assert.match(markdown, /设计标准/);
      assert.match(markdown, /执行标准/);
      assert.match(markdown, /验收标准/);
      assert.match(markdown, /反馈标准/);
      assert.match(markdown, /交付内容标准/);
      assert.match(markdown, /Analytics/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("runs a single natural-language product entry without fixture expectedDecision", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-single-product-"));
    try {
      const jsonPath = path.join(tempDir, "single-product.json");
      const markdownPath = path.join(tempDir, "single-product.md");
      const dbPath = path.join(tempDir, "single-product.sqlite");
      const report = await runCapabilityGapCompleteProduct({
        jsonPath,
        markdownPath,
        dbPath,
        task: "这个任务需要把重复出现的 PRD review standard 沉淀成可复用 skill candidate。",
      });

      assert.equal(report.status, "pass");
      assert.equal(report.summary.mode, "single_task_entry");
      assert.equal(report.summary.inputs, 1);
      assert.equal(report.summary.decisionsCovered, 1);
      assert.equal(report.summary.naturalInferenceWithoutExpectedDecision, true);
      assert.equal(report.productArtifacts[0].gapDecision.decision, "create_skill");
      assert.equal(report.graphValidation.branchExecutionCoverage, 1);
      assert.equal(report.summary.frPassRate, 1);
      assert.equal(report.summary.quantitativePassRate, 1);
      assert.equal(report.aiReadableStandards.status, "pass");

      for (const targetPath of [jsonPath, markdownPath, dbPath]) {
        const file = await stat(targetPath);
        assert.ok(file.size > 0, `${targetPath} should be written`);
      }

      const markdown = await readFile(markdownPath, "utf8");
      assert.match(markdown, /Capability Gap Complete Product MVP Report/);
      assert.doesNotMatch(JSON.stringify(report), sourceLeakPattern);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("redacts Windows, UNC, POSIX, and path-shaped object keys from public reports", () => {
    const sanitized = sanitizeProductReportValue({
      windows: "D:\\PrivateClients\\Acme\\credentials.json",
      unc: "\\\\corp-server\\finance\\secret.xlsx",
      posix: "/srv/private/acme/token.txt",
      embedded:
        "证据位于 D:\\PrivateClients\\Acme\\credentials.json、\\\\corp-server\\finance\\secret.xlsx 和 /srv/private/acme/token.txt。",
      embeddedWithSpaces:
        "证据位于未加引号的 D:\\Private Clients\\Acme\\credentials.json，下一句保留。",
      quotedWithSpaces:
        "证据位于 '\\\\corp-server\\finance data\\secret.xlsx'，下一句保留。",
      apostropheInDoubleQuotes:
        "证据在 \"D:\\Private Clients\\O'Brien\\secret.txt\"，下一句保留。",
      curlyQuotes:
        "证据在 “D:\\Private Clients\\Acme\\secret.txt”，下一句保留。",
      arrowAdjacent:
        "证据→D:\\Private Clients\\Acme\\secret.txt，下一句保留。",
      posixApostrophe:
        "证据在 \"/srv/private/O'Brien/token.txt\"，下一句保留。",
      apiRouteMustRemain: "请求路径 /api/v1/users 应保持。",
      queryRoutesMustRemain:
        "路由 /api?limit=10、/health?full=1、/graphql?query=%7Bviewer%7D 应保持。",
      urlMustRemain: "公开文档 https://example.com/etc/passwd 应保持。",
      ipv6UrlMustRemain: "本地文档 https://[::1]/etc/passwd?view=full#section 应保持。",
      urlWithWindowsPath:
        "https://example.com/open?file=C:/PrivateClients/Acme/credentials.json",
      urlWithFileUri:
        "https://example.com/open?next=file:///srv/private/acme/token.txt",
      urlWithEncodedPath:
        "https://example.com/open?file=C%3A%2FPrivateClients%2FAcme%2Fcredentials.json",
      homeDescendant: `${os.homedir()}\\Private Clients\\Acme\\credentials.json`,
      homeDescendantForwardSlash: `${os
        .homedir()
        .replaceAll("\\", "/")}/Private-Clients/Acme/token.txt`,
      windowsFileUri: "file:///C:/Private%20Clients/Acme/credentials.json",
      posixFileUri: "file:///srv/private/acme/token.txt",
      compactFileUri: "file:/nix/store/private-client/config.json",
      containerPath: "/app/secrets/acme/token.txt",
      nixPath: "/nix/store/private-client/config.json",
      ciPath: "/builds/acme/private/credentials.json",
      keyCollision: {
        "D:\\private\\one.txt": { id: 1 },
        "<local-path-key-1>": { id: 2 },
      },
      generalKeyCollisions: {
        [os.homedir()]: { id: 1 },
        "<user-home>": { id: 2 },
        gstack: { id: 3 },
        "external-skill-provider": { id: 4 },
      },
      "D:\\PrivateClients\\Acme\\path-shaped-key.json": true,
      "\\\\corp-server\\finance\\second-path-key.xlsx": false,
      "/app/secrets/acme/path-shaped-key.txt": "container",
      "file:///C:/Private/path-shaped-key.txt": "file-uri",
    });
    const serialized = JSON.stringify(sanitized);

    assert.doesNotMatch(serialized, sourceLeakPattern);
    assert.doesNotMatch(serialized, sensitivePathFragmentPattern);
    assert.match(serialized, /<local-path>/);
    assert.equal(
      Object.keys(sanitized).filter((key) => /^<local-path-key-\d+>$/.test(key)).length,
      4
    );
    assert.match(sanitized.apiRouteMustRemain, /\/api\/v1\/users/);
    assert.match(
      sanitized.queryRoutesMustRemain,
      /\/api\?limit=10.*\/health\?full=1.*\/graphql\?query=/
    );
    assert.match(sanitized.urlMustRemain, /https:\/\/example\.com\/etc\/passwd/);
    assert.match(
      sanitized.ipv6UrlMustRemain,
      /https:\/\/\[::1\]\/etc\/passwd\?view=full#section/
    );
    assert.equal(
      sanitized.ipv6UrlMustRemain,
      "本地文档 https://[::1]/etc/passwd?view=full#section 应保持。"
    );
    assert.match(sanitized.urlWithWindowsPath, /\?file=<local-path>$/);
    assert.match(sanitized.urlWithFileUri, /\?next=<local-path>$/);
    assert.match(sanitized.urlWithEncodedPath, /\?file=<local-path>$/);
    assert.deepEqual(Object.keys(sanitized.keyCollision).sort(), [
      "<local-path-key-1>",
      "<local-path-key-2>",
    ]);
    assert.deepEqual(
      Object.values(sanitized.keyCollision)
        .map((item) => item.id)
        .sort(),
      [1, 2]
    );
    assert.equal(Object.keys(sanitized.generalKeyCollisions).length, 4);
    assert.deepEqual(
      Object.values(sanitized.generalKeyCollisions)
        .map((item) => item.id)
        .sort(),
      [1, 2, 3, 4]
    );
  });
});
