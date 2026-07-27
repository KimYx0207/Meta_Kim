import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  readGovernedExecutionRun,
  renameWithTransientWindowsRetry,
  runMetaTheoryGovernedExecution,
} from "../../scripts/run-meta-theory-governed-execution.mjs";
import {
  getGovernedRunSurfaceLabels,
  resolveOutputLanguage,
} from "../../scripts/meta-kim-i18n.mjs";
import {
  createInitialState,
  createMetaRunStatusEnvelope,
  writeSpineState,
} from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";

let reportProfileSequence = 0;

function createRepoReportProfile(label) {
  reportProfileSequence += 1;
  return `report-${label}-${process.pid}-${reportProfileSequence}`;
}

function loadPrivatePresentationClassifier() {
  const source = readFileSync(
    path.resolve("scripts/run-meta-theory-governed-execution.mjs"),
    "utf8",
  );
  const start = source.indexOf("function buildCapabilityInvocationPresentation(");
  const end = source.indexOf("\nfunction buildVisibleMetaTheorySurfacePacket(", start);
  assert.ok(start >= 0 && end > start, "private presentation classifier must remain internal");
  const functionSource = source.slice(start, end).replace(/^export\s+/gmu, "");
  return new Function(
    "getGovernedRunSurfaceLabels",
    `${functionSource}; return buildCapabilityInvocationPresentation;`,
  )(getGovernedRunSurfaceLabels);
}

async function writeGovernedReportFixture(outputDir, {
  runId,
  status = "partial",
  language = "en",
  task = "fixture task that must not appear in report selection metadata",
  taskFingerprint = "fixture-fingerprint-that-must-not-appear",
  latest = false,
} = {}) {
  await mkdir(outputDir, { recursive: true });
  const markdownName = `${runId}.${language}.md`;
  await writeFile(
    path.join(outputDir, `${runId}.json`),
    `${JSON.stringify({
      runId,
      status,
      task,
      taskFingerprint,
      runReport: { language, markdownPath: markdownName },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(outputDir, markdownName), `# ${runId}\n`, "utf8");
  if (latest) {
    await writeFile(
      path.join(outputDir, "latest.json"),
      `${JSON.stringify({ runId, jsonPath: `${runId}.json`, markdownPath: markdownName }, null, 2)}\n`,
      "utf8",
    );
  }
}

describe("55 - governed run identity, language, and chat surface", () => {
  test("Windows atomic report rename retries only bounded transient lock errors", async () => {
    const delays = [];
    let attempts = 0;
    await renameWithTransientWindowsRetry("source.tmp", "target.json", {
      platform: "win32",
      retryDelaysMs: [1, 2, 3],
      rename: async () => {
        attempts += 1;
        if (attempts <= 2) {
          const error = new Error("temporarily locked");
          error.code = "EPERM";
          throw error;
        }
      },
      sleep: async (delayMs) => delays.push(delayMs),
    });
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [1, 2]);

    const exhaustedDelays = [];
    let exhaustedAttempts = 0;
    await assert.rejects(
      renameWithTransientWindowsRetry("source.tmp", "target.json", {
        platform: "win32",
        retryDelaysMs: [0, 0],
        rename: async () => {
          exhaustedAttempts += 1;
          const error = new Error("still locked");
          error.code = "EBUSY";
          throw error;
        },
        sleep: async (delayMs) => exhaustedDelays.push(delayMs),
      }),
      { code: "EBUSY" },
    );
    assert.equal(exhaustedAttempts, 3);
    assert.deepEqual(exhaustedDelays, [0, 0]);

    for (const [platform, code] of [
      ["win32", "EINVAL"],
      ["linux", "EPERM"],
    ]) {
      let rejectedAttempts = 0;
      await assert.rejects(
        renameWithTransientWindowsRetry("source.tmp", "target.json", {
          platform,
          retryDelaysMs: [0, 0],
          rename: async () => {
            rejectedAttempts += 1;
            const error = new Error(`non-retryable ${code}`);
            error.code = code;
            throw error;
          },
          sleep: async () => assert.fail("non-transient rename failures must not sleep"),
        }),
        { code },
      );
      assert.equal(rejectedAttempts, 1);
    }
  });

  test("private presentation classifier preserves strict cross-packet priority", () => {
    const classify = loadPrivatePresentationClassifier();
    const packet = ({
      agentState = "selected_not_invoked",
      hintCount = 0,
      requiredBindings = [],
      invokedBindings = [],
      failedBindings = [],
      missingBindings = [],
    }) => ({
      rows: [
        {
          family: "agent_subagent",
          state: agentState,
          selectedCount: requiredBindings.length,
          invokedCount: invokedBindings.length,
          observedCount: 0,
        },
        {
          family: "app_visible_subagent",
          state: "not_required",
          selectedCount: hintCount,
          invokedCount: 0,
          observedCount: 0,
        },
      ],
      realInvocationCoverage: {
        requiredBindings,
        invokedBindings,
        failedBindings,
        missingBindings,
      },
    });
    const bindingA = { family: "agent_subagent", bindingRef: "task-a", providerId: "agent-a" };
    const bindingB = { family: "agent_subagent", bindingRef: "task-b", providerId: "agent-b" };

    for (const [outputLanguage, expectedVisibleText] of [
      ["en", /Some call results returned and some calls failed/u],
      ["zh-CN", /部分调用已返回、部分调用失败/u],
      ["ja-JP", /一部の呼び出し結果が返り、一部は失敗/u],
      ["ko-KR", /일부 호출 결과는 반환되었고 일부 호출은 실패/u],
    ]) {
      const mixed = classify({
        capabilityInvocationTruthPacket: packet({
          agentState: "invoked",
          requiredBindings: [bindingA, bindingB],
          invokedBindings: [bindingA],
          missingBindings: [bindingB],
        }),
        runtimeSubagentInvocationPacket: { status: "denied" },
        outputLanguage,
      });
      assert.equal(mixed.executionState, "called_with_failures");
      assert.equal(mixed.exactBindingState, "exact_binding_pending");
      assert.match(mixed.userSummary, expectedVisibleText);
      assert.doesNotMatch(
        mixed.userSummary,
        /exact binding|exact certification|live certification|精确绑定|精确认证|实时认证|provider|lane/iu,
      );
    }

    const called = classify({
      capabilityInvocationTruthPacket: packet({
        agentState: "invoked",
        invokedBindings: [bindingA],
      }),
      runtimeSubagentInvocationPacket: { status: "invoked" },
      outputLanguage: "zh-CN",
    });
    assert.equal(called.executionState, "called");
    assert.equal(called.evidenceBoundary.successfulBindingCount, 1);
    assert.equal(called.evidenceBoundary.failedBindingCount, 0);
    assert.match(called.userSummary, /已调用。调用结果已返回/u);

    const mismatchedProvider = classify({
      capabilityInvocationTruthPacket: packet({
        agentState: "invoked",
        requiredBindings: [bindingA],
        invokedBindings: [{ ...bindingA, providerId: "agent-other" }],
      }),
      runtimeSubagentInvocationPacket: { status: "invoked" },
      outputLanguage: "en",
    });
    assert.equal(mismatchedProvider.executionState, "called_with_failures");
    assert.equal(mismatchedProvider.evidenceBoundary.exactMatchedBindingCount, 0);
    assert.equal(mismatchedProvider.evidenceBoundary.failedBindingCount, 1);

    const explicitlyFailed = classify({
      capabilityInvocationTruthPacket: packet({
        agentState: "failed",
        requiredBindings: [bindingA],
        invokedBindings: [{ ...bindingA, resultStatus: "failed" }],
      }),
      runtimeSubagentInvocationPacket: { status: "failed" },
      outputLanguage: "en",
    });
    assert.equal(explicitlyFailed.executionState, "not_confirmed");
    assert.equal(explicitlyFailed.evidenceBoundary.successfulBindingCount, 0);
    assert.equal(explicitlyFailed.evidenceBoundary.failedBindingCount, 1);

    for (const [resultStatus, expectedState, expectedText] of [
      ["failed", "failed", /调用失败/u],
      ["denied", "denied", /调用被拒绝/u],
      ["blocked", "blocked", /调用被阻止/u],
    ]) {
      const observedFailure = classify({
        capabilityInvocationTruthPacket: packet({
          agentState: "failed",
          requiredBindings: [bindingA],
          failedBindings: [{ ...bindingA, state: resultStatus, resultStatus }],
          missingBindings: [bindingA],
        }),
        runtimeSubagentInvocationPacket: { status: resultStatus },
        outputLanguage: "zh-CN",
      });
      assert.equal(observedFailure.executionState, expectedState);
      assert.equal(observedFailure.failureDisposition, expectedState);
      assert.match(observedFailure.userSummary, expectedText);
      assert.equal(observedFailure.evidenceBoundary.successfulBindingCount, 0);
      assert.equal(observedFailure.evidenceBoundary.verifiedFailedBindingCount, 1);
      assert.notEqual(observedFailure.executionState, "completed");
      assert.notEqual(observedFailure.executionState, "called");
    }

    const observedMixed = classify({
      capabilityInvocationTruthPacket: packet({
        agentState: "invoked",
        requiredBindings: [bindingA, bindingB],
        invokedBindings: [bindingA],
        failedBindings: [{ ...bindingB, state: "blocked", resultStatus: "blocked" }],
        missingBindings: [bindingB],
      }),
      runtimeSubagentInvocationPacket: { status: "blocked" },
      outputLanguage: "en",
    });
    assert.equal(observedMixed.executionState, "called_with_failures");
    assert.equal(observedMixed.evidenceBoundary.successfulBindingCount, 1);
    assert.equal(observedMixed.evidenceBoundary.verifiedFailedBindingCount, 1);

    const localeExpectations = {
      en: {
        failed: /Call failed/u,
        denied: /Call denied/u,
        blocked: /Call blocked/u,
        called_with_failures: /Called \(some invocations failed\)/u,
      },
      "zh-CN": {
        failed: /调用失败/u,
        denied: /调用被拒绝/u,
        blocked: /调用被阻止/u,
        called_with_failures: /已调用（部分失败）/u,
      },
      "ja-JP": {
        failed: /呼び出し失敗/u,
        denied: /呼び出し拒否/u,
        blocked: /呼び出しがブロックされました/u,
        called_with_failures: /呼び出し済み（一部失敗）/u,
      },
      "ko-KR": {
        failed: /호출 실패/u,
        denied: /호출 거부됨/u,
        blocked: /호출 차단됨/u,
        called_with_failures: /호출됨\(일부 실패\)/u,
      },
    };
    for (const [outputLanguage, expected] of Object.entries(localeExpectations)) {
      for (const failureState of ["failed", "denied", "blocked"]) {
        const failure = classify({
          capabilityInvocationTruthPacket: packet({
            requiredBindings: [bindingA],
            failedBindings: [{
              ...bindingA,
              state: failureState,
              resultStatus: failureState,
            }],
            missingBindings: [bindingA],
          }),
          outputLanguage,
        });
        assert.equal(failure.executionState, failureState);
        assert.match(failure.executionLabel, expected[failureState]);
        assert.match(failure.userSummary, expected[failureState]);
      }
      const mixedForLocale = classify({
        capabilityInvocationTruthPacket: packet({
          requiredBindings: [bindingA, bindingB],
          invokedBindings: [bindingA],
          failedBindings: [{ ...bindingB, state: "denied", resultStatus: "denied" }],
          missingBindings: [bindingB],
        }),
        outputLanguage,
      });
      assert.equal(mixedForLocale.executionState, "called_with_failures");
      assert.match(mixedForLocale.executionLabel, expected.called_with_failures);
      assert.match(mixedForLocale.userSummary, expected.called_with_failures);
    }

    const runnerSource = readFileSync(
      path.resolve("scripts/run-meta-theory-governed-execution.mjs"),
      "utf8",
    );
    assert.match(
      runnerSource,
      /providerPresentationSummary: coreLoop\.capabilityInvocationPresentationPacket\.userSummary/u,
    );
    assert.ok(
      runnerSource.includes(
        "${report.providers}: ${capabilityInvocationPresentationPacket?.userSummary",
      ),
    );

    const untrustedHint = classify({
      capabilityInvocationTruthPacket: packet({ agentState: "unavailable", hintCount: 2 }),
      runtimeSubagentInvocationPacket: {
        status: "unavailable",
        availabilityDisposition: "host_evidence_unattached",
      },
      outputLanguage: "zh-CN",
    });
    assert.equal(untrustedHint.executionState, "not_confirmed");
    assert.match(untrustedHint.summary, /^运行记录待关联（以当前聊天中的实际调用结果为准）/u);

    const trulyUnavailable = classify({
      capabilityInvocationTruthPacket: packet({ agentState: "unavailable" }),
      runtimeSubagentInvocationPacket: {
        status: "unsupported",
        availabilityDisposition: "genuinely_unavailable",
      },
      outputLanguage: "zh-CN",
    });
    assert.equal(trulyUnavailable.executionState, "unavailable");
    assert.match(trulyUnavailable.summary, /^不可用/u);

    for (const unverifiedFailureStatus of ["denied", "blocked", "failed"]) {
      const unverifiedFailure = classify({
        capabilityInvocationTruthPacket: packet({
          agentState: unverifiedFailureStatus,
          requiredBindings: [bindingA],
          missingBindings: [bindingA],
        }),
        runtimeSubagentInvocationPacket: {
          status: unverifiedFailureStatus,
          availabilityDisposition: "genuinely_unavailable",
        },
        outputLanguage: "zh-CN",
      });
      assert.equal(unverifiedFailure.executionState, "not_confirmed");
      assert.equal(unverifiedFailure.failureDisposition, null);
      assert.match(unverifiedFailure.userSummary, /目前尚未关联到成功的调用结果/u);
      assert.doesNotMatch(unverifiedFailure.userSummary, /不可用|调用失败|调用被拒绝|调用被阻止/u);
    }

    const selectedUnobserved = classify({
      capabilityInvocationTruthPacket: packet({
        agentState: "selected_not_invoked",
        requiredBindings: [bindingA],
        missingBindings: [bindingA],
      }),
      runtimeSubagentInvocationPacket: {
        status: "unavailable",
        availabilityDisposition: "host_evidence_unattached",
      },
      outputLanguage: "zh-CN",
    });
    assert.equal(selectedUnobserved.executionState, "not_confirmed");
    assert.match(selectedUnobserved.summary, /^运行记录待关联（以当前聊天中的实际调用结果为准）/u);

    const exactInvoked = classify({
      capabilityInvocationTruthPacket: packet({
        agentState: "invoked",
        requiredBindings: [bindingA],
        invokedBindings: [bindingA],
      }),
      runtimeSubagentInvocationPacket: { status: "invoked" },
      outputLanguage: "zh-CN",
    });
    assert.equal(exactInvoked.executionState, "completed");
    assert.equal(exactInvoked.exactBindingState, "exact_binding_verified");
    assert.equal(exactInvoked.liveCertificationState, "live_certification_pending");
    assert.match(exactInvoked.userSummary, /调用结果已返回，运行记录已关联/u);

    const successCannotBecomeUnavailable = classify({
      capabilityInvocationTruthPacket: packet({
        agentState: "invoked",
        invokedBindings: [bindingA],
      }),
      runtimeSubagentInvocationPacket: {
        status: "failed",
        availabilityDisposition: "genuinely_unavailable",
      },
      outputLanguage: "en",
    });
    assert.equal(successCannotBecomeUnavailable.executionState, "called");

    assert.doesNotMatch(
      readFileSync(path.resolve("scripts/run-meta-theory-governed-execution.mjs"), "utf8"),
      /export function buildCapabilityInvocationPresentation|hostSubagentLifecycleEvidence|verifiedAttestationResult|hostAssistantMessageEvidenceTrusted/u,
    );
    const runtimeContract = readFileSync(
      path.resolve("canonical/skills/meta-theory/references/runtime-codex.md"),
      "utf8",
    );
    assert.match(runtimeContract, /normal chat uses the actual native results from the current turn/u);
    assert.match(runtimeContract, /Runner-side assistant-message input is diagnostic only/u);
    assert.match(runtimeContract, /runner exposes no `hostInvocationEvidenceTrusted` input/u);
  });

  test("unverified host-visible names never promote runner presentation or visible surfaces", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-host-visible-presentation-"));
    try {
      const hintOnlyRun = await runMetaTheoryGovernedExecution({
        task: "使用多个 agent 审查并修复这个可配置工作流",
        runId: "host-visible-hint-only",
        outputLanguage: "zh-CN",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
        emitConversationNotice: true,
        hostVisibleSubagents: ["ux-reviewer"],
      });
      assert.equal(hintOnlyRun.capabilityInvocationPresentationPacket.executionState, "not_confirmed");
      assert.doesNotMatch(hintOnlyRun.capabilityInvocationPresentationPacket.summary, /已调用/u);
      assert.match(
        hintOnlyRun.conversationNotice.progressEvents.find((event) => event.stage === "Execution").reason,
        /正在准备派发并等待宿主确认/u,
      );

      const rawAgent = hintOnlyRun.capabilityInvocationTruthPacket.rows.find(
        (row) => row.family === "agent_subagent",
      );
      const rawHost = hintOnlyRun.capabilityInvocationTruthPacket.rows.find(
        (row) => row.family === "app_visible_subagent",
      );
      assert.equal(rawAgent.state, "not_required");
      assert.equal(rawHost.state, "not_required");
      assert.equal(hintOnlyRun.capabilityInvocationTruthPacket.stateCounts.not_required >= 2, true);
      assert.equal(hintOnlyRun.capabilityInvocationTruthPacket.stateCounts.host_visible_observed ?? 0, 0);
      const routeBlock = hintOnlyRun.conversationNotice.blocks.find((block) => block.id === "route");
      assert.match(routeBlock.lines.join("\n"), /调用记录: 运行记录待关联.*独立复核/u);
      assert.doesNotMatch(routeBlock.lines.join("\n"), /已调用|能力\/provider 调用状态: 不可用/u);
      const markdown = await readFile(hintOnlyRun.paths.markdown, "utf8");
      assert.match(markdown, /调用记录: 运行记录待关联.*独立复核/u);
      assert.doesNotMatch(
        `${routeBlock.lines.join("\n")}\n${markdown}`,
        /精确绑定|精确认证|实时认证|provider|lane/iu,
      );
      assert.doesNotMatch(markdown, /agent_subagent \| unavailable/u);
      assert.doesNotMatch(
        markdown,
        /capabilityInvocationPresentationPacket|executionState|not_confirmed|called_with_failures|selected_not_invoked_relabel/u,
      );
      assert.equal(hintOnlyRun.visibleMetaTheorySurfacePacket.capabilityInvocationTruth, undefined);
      assert.equal(
        hintOnlyRun.visibleMetaTheorySurfacePacket.capabilityInvocationPresentation.userSummary,
        hintOnlyRun.capabilityInvocationPresentationPacket.userSummary,
      );
      assert.equal(hintOnlyRun.runReportPanelContract.capabilityInvocationTruth, undefined);
      assert.equal(
        hintOnlyRun.runReportPanelContract.capabilityInvocationPresentation.userSummary,
        hintOnlyRun.capabilityInvocationPresentationPacket.userSummary,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("chat and report expose capability-family decisions and the project customization decision", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-capability-ledger-surface-"));
    try {
      const run = await runMetaTheoryGovernedExecution({
        task: "帮我检查 Agent、Skill、Command、MCP 是否真的调用，并明确项目级能力是否需要创建",
        runId: "capability-ledger-surface",
        outputLanguage: "zh-CN",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
        emitConversationNotice: true,
      });

      const ledger = run.capabilityLedgerPacket;
      assert.equal(ledger.title, "本次能力使用明细");
      assert.equal(typeof ledger.userSummary, "string");
      for (const family of ["agent_subagent", "skill", "command_script", "mcp"]) {
        const row = ledger.families.find((candidate) => candidate.family === family);
        assert.ok(row, `${family} must be visible in the capability ledger`);
        assert.equal(typeof row.familyLabel, "string");
        assert.equal(typeof row.stateLabel, "string");
        assert.equal(typeof row.invocationTruthBoundary, "string");
        assert.equal(typeof row.nextAction, "string");
        assert.ok(row.familyLabel.length > 0);
        assert.ok(row.nextAction.length > 0);
      }
      assert.equal(
        run.projectCustomizationPacket?.decision,
        "use_global_directly",
        "asking whether project capability creation is needed must not be treated as authorization to create",
      );
      assert.equal(run.projectCustomizationPacket?.requestedCapabilityCount, 0);
      assert.equal(run.projectCustomizationPacket?.targetPath, null);
      assert.equal(typeof run.projectCustomizationPacket?.reason, "string");
      assert.equal(typeof run.projectCustomizationPacket?.verification, "string");
      assert.equal(typeof run.projectCustomizationPacket?.rollback, "string");
      assert.ok(
        ["use_global_directly", "upgrade_existing_owner", "create_project_local_capability"].includes(
          run.projectCustomizationPacket?.decision,
        ),
      );

      const routeBlock = run.conversationNotice.blocks.find((block) => block.id === "route");
      const routeText = routeBlock.lines.join("\n");
      assert.match(routeText, /本次能力使用明细/u);
      assert.match(routeText, /Agent \/ 子代理/u);
      assert.match(routeText, /Skill/u);
      assert.match(routeText, /Command \/ 脚本/u);
      assert.match(routeText, /MCP/u);
      assert.match(routeText, /项目能力处理决定/u);
      assert.doesNotMatch(routeText, /providerId|selected_not_invoked|capabilityLedgerPacket/u);

      const markdown = await readFile(run.paths.markdown, "utf8");
      assert.match(markdown, /工作协调与调用情况/u);
      assert.match(markdown, /Agent \/ 子代理/u);
      assert.match(markdown, /Command \/ 脚本/u);
      assert.match(markdown, /MCP/u);
      assert.match(markdown, /项目能力处理决定/u);
      assert.doesNotMatch(markdown, /providerId|capabilityLedgerPacket/u);
      assert.equal(
        run.visibleMetaTheorySurfacePacket.capabilityLedger.userSummary,
        ledger.userSummary,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("omitted runId preserves task fingerprint but creates unique run history", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-unique-run-"));
    try {
      const input = {
        task: "检查同一个任务的运行历史不能互相覆盖",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
      };
      const first = await runMetaTheoryGovernedExecution(input);
      const second = await runMetaTheoryGovernedExecution(input);

      assert.notEqual(first.runId, second.runId);
      assert.equal(first.taskFingerprint, second.taskFingerprint);
      for (const run of [first, second]) {
        assert.equal(existsSync(run.paths.json), true);
        assert.equal(existsSync(run.paths.markdown), true);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("explicit runId stays compatible and resolved language reaches report, packets, and chat blocks", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-language-run-"));
    try {
      const run = await runMetaTheoryGovernedExecution({
        task: "Please keep the essential guidance in the chat window.",
        runId: "explicit-language-run",
        outputLanguage: "ja",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
        emitConversationNotice: true,
      });

      assert.equal(run.runId, "explicit-language-run");
      assert.equal(run.resolvedOutputLanguage, "ja-JP");
      assert.equal(run.languageResolution.source, "explicit_option");
      assert.match(run.paths.markdown, /explicit-language-run\.ja-JP\.md$/u);
      assert.equal(run.runReport.language, "ja-JP");
      assert.equal(run.intentGatePacket.userLanguage, "ja-JP");
      assert.ok(run.cardPlanPacket.cardEvents.every((event) => event.userLanguage === "ja-JP"));
      assert.equal(run.conversationNotice.language, "ja-JP");
      assert.equal(run.conversationNotice.blockCount, 3);
      assert.ok(run.conversationNotice.blocks.length <= 3);

      const coveredFields = new Set(
        run.conversationNotice.blocks.flatMap((block) => block.fields),
      );
      for (const field of [
        "stage",
        "currentWork",
        "owner",
        "capability",
        "result",
        "riskOrBlocker",
        "verification",
        "nextAction",
      ]) {
        assert.equal(coveredFields.has(field), true, `missing chat field: ${field}`);
      }
      const routeBlock = run.conversationNotice.blocks.find((block) => block.id === "route");
      assert.match(routeBlock.lines.join("\n"), /Meta_Kim 調整機能/u);
      assert.match(routeBlock.lines.join("\n"), /実行記録は関連付け待ちです.*独立レビュー/u);
      assert.doesNotMatch(routeBlock.lines.join("\n"), /利用不可/u);
      assert.match(routeBlock.lines.join("\n"), /協働役割/u);
      assert.match(routeBlock.lines.join("\n"), /作業フロー/u);
      assert.doesNotMatch(routeBlock.lines.join("\n"), /owner=|mode=|peers=|handoffs=|nodes=|state=/u);
      const closureBlock = run.conversationNotice.blocks.find((block) => block.id === "closure");
      assert.match(closureBlock.lines.join("\n"), /一部完了/u);
      assert.match(closureBlock.lines.join("\n"), /追加の証拠/u);
      assert.doesNotMatch(closureBlock.lines.join("\n"), /Current result: pass/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("language priority and legacy zh-CN report readback remain compatible", async () => {
    assert.deepEqual(
      resolveOutputLanguage({
        explicitLanguage: "ko",
        cliLanguage: "ja",
        environmentLanguage: "en",
        latestInput: "中文输入",
        systemLanguage: "en-US",
      }),
      { language: "ko-KR", source: "explicit_option" },
    );

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-legacy-read-"));
    try {
      const runId = "legacy-zh-run";
      await writeFile(
        path.join(tempDir, `${runId}.json`),
        `${JSON.stringify({ runId, status: "partial" })}\n`,
      );
      await writeFile(path.join(tempDir, `${runId}.zh-CN.md`), "# 旧版中文报告\n");
      const readBack = await readGovernedExecutionRun({ runId, stateDir: tempDir });
      assert.match(readBack.markdown, /旧版中文报告/u);
      assert.match(readBack.paths.markdown, /legacy-zh-run\.zh-CN\.md$/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("CLI language option overrides latest input language", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-cli-language-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/run-meta-theory-governed-execution.mjs",
          "--task",
          "中文任务仍应服从显式 CLI 输出语言",
          "--run-id",
          "cli-language-run",
          "--lang",
          "en",
          "--state-dir",
          tempDir,
          "--db",
          path.join(tempDir, "runs.sqlite"),
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout);
      assert.match(summary.report, /cli-language-run\.en\.md$/u);
      const artifact = JSON.parse(
        await readFile(path.join(tempDir, "cli-language-run.json"), "utf8"),
      );
      assert.equal(artifact.resolvedOutputLanguage, "en");
      assert.equal(artifact.languageResolution.source, "cli_option");
      const duplicate = spawnSync(
        process.execPath,
        [
          "scripts/run-meta-theory-governed-execution.mjs",
          "--task",
          "replacement",
          "--run-id",
          "cli-language-run",
          "--lang",
          "en",
          "--state-dir",
          tempDir,
          "--db",
          path.join(tempDir, "runs.sqlite"),
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      assert.equal(duplicate.status, 1);
      assert.match(duplicate.stderr, /already exists/u);
      const overwrite = spawnSync(
        process.execPath,
        [
          "scripts/run-meta-theory-governed-execution.mjs",
          "--task",
          "replacement",
          "--run-id",
          "cli-language-run",
          "--lang",
          "en",
          "--state-dir",
          tempDir,
          "--db",
          path.join(tempDir, "runs.sqlite"),
          "--overwrite-run",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      assert.equal(overwrite.status, 0, overwrite.stderr);
      const overwrittenArtifact = JSON.parse(
        await readFile(path.join(tempDir, "cli-language-run.json"), "utf8"),
      );
      assert.equal(overwrittenArtifact.overwriteAuthorized, true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("runId rejects traversal and existing explicit ids require overwrite authorization", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-safe-run-id-"));
    try {
      for (const unsafeRunId of ["../escape", "nested/run", "nested\\run", ".."]){
        await assert.rejects(
          runMetaTheoryGovernedExecution({
            task: "safe run identity",
            runId: unsafeRunId,
            stateDir: tempDir,
            dbPath: path.join(tempDir, "runs.sqlite"),
          }),
          /Invalid requested runId/u,
        );
      }

      const first = await runMetaTheoryGovernedExecution({
        task: "first explicit run",
        runId: "protected-run",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
      });
      await assert.rejects(
        runMetaTheoryGovernedExecution({
          task: "second explicit run",
          runId: "protected-run",
          stateDir: tempDir,
          dbPath: path.join(tempDir, "runs.sqlite"),
        }),
        /already exists/u,
      );
      const replaced = await runMetaTheoryGovernedExecution({
        task: "authorized replacement",
        runId: "protected-run",
        allowOverwrite: true,
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
      });
      assert.equal(first.requestedRunId, "protected-run");
      assert.equal(replaced.overwriteAuthorized, true);

      await writeFile(
        path.join(tempDir, "latest.json"),
        `${JSON.stringify({ runId: "../outside" })}\n`,
      );
      await assert.rejects(
        readGovernedExecutionRun({ runId: "latest", stateDir: tempDir }),
        /Invalid latest\.json runId/u,
      );
      assert.equal(
        (await readdir(tempDir)).some((name) => name.endsWith(".tmp")),
        false,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("report selection distinguishes the newest committed pointer, partial claim, and explicit run", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-report-selection-"));
    try {
      await writeGovernedReportFixture(tempDir, {
        runId: "older-committed-run",
        status: "pass",
      });
      await writeGovernedReportFixture(tempDir, {
        runId: "newest-committed-run",
        status: "partial",
        latest: true,
      });

      const latest = await readGovernedExecutionRun({ runId: "latest", stateDir: tempDir });
      assert.equal(latest.runId, "newest-committed-run");
      assert.equal(latest.artifact.status, "partial");
      assert.deepEqual(latest.selection, {
        schemaVersion: "governed-report-selection-v1",
        selectionSource: "latest_committed_pointer",
        selectionReason: "last_committed_governed_report",
        selectionExplanation: "latest.json is the atomic pointer to the newest committed governed report; it does not claim to identify the active host run.",
        selectedRunId: "newest-committed-run",
        artifactClaimStatus: "partial",
        activeRunRelation: "not_checked_custom_output",
        activeRunId: null,
        warning: null,
        continuationMode: "report_only",
        nextCommand: null,
      });

      const explicit = await readGovernedExecutionRun({
        runId: "older-committed-run",
        stateDir: tempDir,
      });
      assert.equal(explicit.runId, "older-committed-run");
      assert.equal(explicit.selection.selectionSource, "explicit_run_id");
      assert.equal(explicit.selection.selectionReason, "explicit_committed_run_id");
      assert.match(explicit.selection.selectionExplanation, /explicit runId/u);
      assert.equal(explicit.selection.artifactClaimStatus, "pass");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("latest returns an unlinked active lifecycle warning without disclosing task identity", async () => {
    const profile = createRepoReportProfile("active-relation");
    const profileDir = path.join(process.cwd(), ".meta-kim", "state", profile);
    try {
      const executionDir = path.join(profileDir, "governed-executions");
      const committedSecret = "committed task secret must remain private";
      const fingerprintSecret = `hmac-sha256:${"a".repeat(64)}`;
      await writeGovernedReportFixture(executionDir, {
        runId: "committed-report-run",
        status: "partial",
        task: committedSecret,
        taskFingerprint: "private-committed-fingerprint",
        latest: true,
      });
      const activeState = createInitialState({
        taskFingerprint: fingerprintSecret,
        taskIdentitySource: "project_profile_hmac_sha256",
        taskClassification: "report_selection_fixture",
        triggerReason: "test_fixture",
      });
      activeState.stateProfile = profile;
      await writeSpineState(process.cwd(), activeState);

      const run = await readGovernedExecutionRun({ runId: "latest", stateDir: executionDir });
      assert.equal(run.runId, "committed-report-run");
      assert.equal(run.selection.activeRunRelation, "different_active_run");
      assert.equal(run.selection.activeRunId, activeState.runId);
      assert.match(run.selection.warning, /committed artifact/u);
      assert.equal(
        run.selection.nextCommand,
        `npm run meta:run-status -- --profile=${profile}`,
      );
      assert.equal(run.selection.continuationMode, "inspect_active_lifecycle");

      const cli = spawnSync(
        process.execPath,
        [
          "scripts/run-meta-theory-governed-execution.mjs",
          "--read",
          "latest",
          "--state-dir",
          executionDir,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      assert.equal(cli.status, 0, cli.stderr);
      const summary = JSON.parse(cli.stdout);
      assert.equal(summary.status, "partial");
      assert.equal(summary.selection.activeRunRelation, "different_active_run");
      const publicSelection = JSON.stringify(summary.selection);
      assert.doesNotMatch(publicSelection, new RegExp(committedSecret));
      assert.doesNotMatch(publicSelection, new RegExp(fingerprintSecret));
      assert.equal("task" in summary.selection, false);
      assert.equal("taskFingerprint" in summary.selection, false);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("artifact-dir remains authoritative and does not consult state-dir active lifecycle state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-report-artifact-authority-"));
    try {
      const profileDir = path.join(tempDir, ".meta-kim", "state", "default");
      const stateDir = path.join(profileDir, "governed-executions");
      const artifactDir = path.join(tempDir, "custom-artifacts");
      await mkdir(profileDir, { recursive: true });
      await writeFile(
        path.join(profileDir, "active-run.json"),
        `${JSON.stringify({ active: true, runId: "unrelated-default-active-run" })}\n`,
        "utf8",
      );
      await writeGovernedReportFixture(artifactDir, {
        runId: "custom-artifact-run",
        latest: true,
      });

      const run = await readGovernedExecutionRun({
        runId: "latest",
        stateDir,
        artifactDir,
      });
      assert.equal(run.runId, "custom-artifact-run");
      assert.equal(run.selection.activeRunRelation, "not_checked_custom_output");
      assert.equal(run.selection.activeRunId, null);
      assert.doesNotMatch(JSON.stringify(run.selection), /unrelated-default-active-run/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("missing or invalid active lifecycle state cannot block a valid committed report", async () => {
    const profile = createRepoReportProfile("active-failsafe");
    const profileDir = path.join(process.cwd(), ".meta-kim", "state", profile);
    try {
      const executionDir = path.join(profileDir, "governed-executions");
      await writeGovernedReportFixture(executionDir, {
        runId: "failsafe-committed-run",
        latest: true,
      });

      const missing = await readGovernedExecutionRun({ runId: "latest", stateDir: executionDir });
      assert.equal(missing.runId, "failsafe-committed-run");
      assert.equal(missing.selection.activeRunRelation, "none");
      assert.equal(missing.selection.continuationMode, "no_active_projection");
      assert.equal(missing.selection.nextCommand, null);

      await writeFile(path.join(profileDir, "active-run.json"), "{not-json\n", "utf8");
      const invalid = await readGovernedExecutionRun({ runId: "latest", stateDir: executionDir });
      assert.equal(invalid.runId, "failsafe-committed-run");
      assert.equal(invalid.selection.activeRunRelation, "unknown_invalid_projection");
      assert.equal(invalid.selection.activeRunId, null);
      assert.match(invalid.selection.warning, /could not be validated/u);
      assert.equal(
        invalid.selection.nextCommand,
        `npm run meta:run-status -- --profile=${profile}`,
      );
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("weak or lifecycle-inconsistent active projections stay untrusted and never block partial reports", async () => {
    const profile = createRepoReportProfile("active-weak");
    const profileDir = path.join(process.cwd(), ".meta-kim", "state", profile);
    try {
      const executionDir = path.join(profileDir, "governed-executions");
      await writeGovernedReportFixture(executionDir, {
        runId: "weak-projection-committed-run",
        status: "partial",
        latest: true,
      });

      await writeFile(
        path.join(profileDir, "active-run.json"),
        `${JSON.stringify({ active: true, runId: "meta-weak-active-run" })}\n`,
        "utf8",
      );
      const weak = await readGovernedExecutionRun({ runId: "latest", stateDir: executionDir });
      assert.equal(weak.runId, "weak-projection-committed-run");
      assert.equal(weak.artifact.status, "partial");
      assert.equal(weak.selection.activeRunRelation, "unknown_invalid_projection");
      assert.equal(weak.selection.activeRunId, null);

      const inconsistent = createMetaRunStatusEnvelope({
        active: true,
        runId: "meta-inconsistent-active-run",
        taskClassification: "report_selection_fixture",
        triggerReason: "test_fixture",
        currentStage: "execution",
      });
      inconsistent.lifecycleStatus = "session_stopped";
      await writeFile(
        path.join(profileDir, "active-run.json"),
        `${JSON.stringify(inconsistent)}\n`,
        "utf8",
      );
      const cli = spawnSync(
        process.execPath,
        [
          "scripts/run-meta-theory-governed-execution.mjs",
          "--read",
          "latest",
          "--state-dir",
          executionDir,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      assert.equal(cli.status, 0, cli.stderr);
      const summary = JSON.parse(cli.stdout);
      assert.equal(summary.status, "partial");
      assert.equal(summary.runId, "weak-projection-committed-run");
      assert.equal(summary.selection.activeRunRelation, "unknown_invalid_projection");
      assert.equal(summary.selection.activeRunId, null);
      assert.doesNotMatch(JSON.stringify(summary.selection), /meta-inconsistent-active-run/u);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("conversation progress callback receives real ordered stage transitions", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-progress-events-"));
    const events = [];
    try {
      const run = await runMetaTheoryGovernedExecution({
        task: "Build a safe configurable workflow and review it.",
        runId: "progress-event-run",
        outputLanguage: "en",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
        emitConversationNotice: true,
        onConversationProgress: (event) => events.push(event),
      });
      assert.deepEqual(
        events.map((event) => event.stage),
        ["Critical", "Fetch", "Thinking", "Execution", "Review", "Closure", "Aggregate"],
      );
      assert.equal(events[2].status, "route_ready_before_execution");
      assert.equal(run.conversationNotice.progressStreamed, true);
      assert.equal(run.conversationNotice.progressEvents.length, 6);
      assert.match(events.at(-1).text, /Route and ownership/u);
      assert.deepEqual(
        run.conversationNotice.hostObservationExpectations,
        events.map((event) => ({ stage: event.stage, textSha256: event.textSha256 })),
      );
      assert.equal(run.conversationNotice.hostObservation.status, "host_observation_required");
      assert.equal(run.userExperienceNotice.status, "partial");
      assert.equal(run.userExperienceNotice.hostObservationStatus, "host_observation_required");
      assert.equal(run.userExperienceNotice.conversationNoticeEmitted, true);
      assert.equal(run.userExperienceNotice.conversationNoticeObserved, false);
      assert.match(run.userExperienceNotice.statusReason, /transport only/u);

      const observedRun = await runMetaTheoryGovernedExecution({
        task: "Build a safe configurable workflow and review it.",
        runId: "progress-event-run",
        allowOverwrite: true,
        outputLanguage: "en",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
        emitConversationNotice: true,
        hostAssistantMessageEvidence: run.conversationNotice.hostObservationExpectations.map(
          (expectation, index) => ({
            sessionId: "root-host-session",
            messageId: `host-message-${index}`,
            eventId: `host-event-${index}`,
            textSha256: expectation.textSha256,
            resultStatus: "completed",
            mainThreadChat: true,
          }),
        ),
      });
      assert.equal(observedRun.conversationNotice.hostObservation.status, "host_observation_required");
      assert.equal(
        observedRun.conversationNotice.hostObservation.reason,
        "runner_host_observation_is_diagnostic_only",
      );
      assert.equal(observedRun.userExperienceNotice.status, "partial");
      assert.equal(observedRun.userExperienceNotice.conversationNoticeObserved, false);

      const cliDir = path.join(tempDir, "cli");
      const cli = spawnSync(
        process.execPath,
        [
          "scripts/run-meta-theory-governed-execution.mjs",
          "--task",
          "Build and review a staged workflow.",
          "--run-id",
          "cli-progress-run",
          "--output-language",
          "en",
          "--state-dir",
          cliDir,
          "--db",
          path.join(cliDir, "runs.sqlite"),
          "--emit-conversation-notice",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      assert.equal(cli.status, 0, cli.stderr);
      const summary = JSON.parse(cli.stdout);
      assert.equal(summary.runId, "cli-progress-run");
      const stageOffsets = ["[Critical]", "[Fetch]", "[Thinking]", "[Execution]", "[Review]", "[Closure]"]
        .map((marker) => cli.stderr.indexOf(marker));
      assert.ok(stageOffsets.every((offset) => offset >= 0));
      assert.deepEqual(stageOffsets, [...stageOffsets].sort((a, b) => a - b));
      assert.ok(cli.stderr.indexOf("[Thinking]") < cli.stderr.indexOf("- Route and ownership"));
      assert.match(cli.stderr, /Preparing dispatch and waiting for host confirmation/u);
      assert.match(cli.stderr, /closure check is consolidating the result, verification, and next action/u);
      assert.match(cli.stderr, /transport only/u);
      assert.doesNotMatch(cli.stderr, /\[Closure\].*verification=pass/u);
      assert.doesNotMatch(cli.stdout, /\[Critical\]|Route and ownership/u);
      const cliArtifact = JSON.parse(
        await readFile(path.join(cliDir, "cli-progress-run.json"), "utf8"),
      );
      assert.equal(cliArtifact.conversationNotice.outputBoundary, "stderr_progress_channel");
      assert.equal(cliArtifact.userExperienceNotice.status, "partial");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("English, Japanese, and Korean key chat/report surfaces do not leak Chinese templates", async () => {
    const cases = [
      ["en", "Build a modular workflow.", /[\u3400-\u9fff，。；：、]/u],
      ["ja", "モジュール化されたワークフローを構築してください。", /用户目标状态|编排检查状态|开始原因|自动化与人工决策边界|三目标产品验收/u],
      ["ko", "모듈형 워크플로를 만들어 주세요.", /[\u3400-\u9fff]/u],
    ];
    for (const [language, task, forbidden] of cases) {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), `meta-kim-locale-${language}-`));
      try {
        const run = await runMetaTheoryGovernedExecution({
          task,
          runId: `locale-${language}`,
          outputLanguage: language,
          stateDir: tempDir,
          dbPath: path.join(tempDir, "runs.sqlite"),
          emitConversationNotice: true,
        });
        assert.doesNotMatch(run.conversationNotice.text, forbidden);
        const markdown = await readFile(run.paths.markdown, "utf8");
        assert.doesNotMatch(markdown, forbidden);
        assert.match(markdown, /Meta_Kim/u);
        assert.match(markdown, /Critical/u);
        assert.match(markdown, /Verification/u);
        assert.doesNotMatch(
          `${run.conversationNotice.text}\n${markdown}`,
          /status=|owner=|next=|selected_not_invoked|missingBindings|capabilityInvocationPresentationPacket|executionState/u,
        );
        assert.doesNotMatch(
          `${run.conversationNotice.text}\n${markdown}`,
          /exact binding|exact certification|live certification|精确绑定|精确认证|实时认证|providerId|bindingRef|parallelGroup|shardScope|runtimeInstanceAlias/iu,
        );
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  test("exclusive reservation prevents concurrent explicit run creation", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-run-reservation-"));
    try {
      const input = {
        task: "concurrent reservation check",
        runId: "concurrent-run",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
      };
      const results = await Promise.allSettled([
        runMetaTheoryGovernedExecution(input),
        runMetaTheoryGovernedExecution(input),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      assert.match(results.find((result) => result.status === "rejected").reason.message, /reserved|already exists/u);
      assert.equal(existsSync(path.join(tempDir, "concurrent-run.reservation.json")), true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("readback rejects mismatched artifact and cross-run markdown binding", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-read-binding-"));
    try {
      await writeFile(
        path.join(tempDir, "bound-run.json"),
        `${JSON.stringify({ runId: "other-run", runReport: { markdownPath: "bound-run.en.md" } })}\n`,
      );
      await writeFile(path.join(tempDir, "bound-run.en.md"), "# report\n");
      await assert.rejects(
        readGovernedExecutionRun({ runId: "bound-run", stateDir: tempDir }),
        /binding mismatch/u,
      );

      await writeFile(
        path.join(tempDir, "bound-run.json"),
        `${JSON.stringify({ runId: "bound-run", runReport: { markdownPath: "other-run.en.md" } })}\n`,
      );
      await assert.rejects(
        readGovernedExecutionRun({ runId: "bound-run", stateDir: tempDir }),
        /report binding mismatch/u,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
