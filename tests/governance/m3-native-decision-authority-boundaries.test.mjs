import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { resolveCurrentHostHandoff } from "../../scripts/current-host-execution-authority.mjs";
import {
  buildHostAnswerClaim,
  claimHostAnswer,
  createDecision,
  decisionExecutionGate,
  HOST_RECEIPT_ADAPTERS,
  presentDecision,
} from "../../src/domain/decision/decision.mjs";
import {
  buildCardPlanPacketDecisionProjection,
  buildPreDecisionOptionFrameProjection,
  buildRouteGateDecisionProjection,
} from "../../src/domain/decision/legacy-decision-projection.mjs";

const DECISION_SOURCE_FILES = [
  "src/domain/decision/decision.mjs",
  "src/domain/decision/legacy-decision-projection.mjs",
  "src/domain/decision/native-decision-authority.mjs",
  "src/domain/decision/native-host-answer-authority.mjs",
  "src/data/schemas/decision.schema.json",
  "src/data/schemas/native-decision-authority.schema.json",
  "src/data/schemas/native-host-answer-authority.schema.json",
  "src/adapters/codex/native-decision-surface-adapter.mjs",
  "src/adapters/codex/app-server-decision-host-adapter.mjs",
  "src/adapters/claude/native-decision-surface-adapter.mjs",
  "src/adapters/claude/sdk-decision-host-adapter.mjs",
];

const HOST_ANSWER_REPOSITORY = "src/data/repositories/native-host-answer-repository.mjs";
const HOST_RUNTIME_ADAPTERS = [
  {
    path: "src/adapters/codex/app-server-decision-host-adapter.mjs",
    injectedRepositoryPort: /exactPort\(current\.repository,\s*["']repository["']/u,
  },
  {
    path: "src/adapters/claude/sdk-decision-host-adapter.mjs",
    injectedRepositoryPort: /const\s+\{\s*hostPort,\s*repository\s*\}\s*=\s*options;/u,
  },
];
const PURE_DECISION_DOMAIN = [
  "src/domain/decision/decision.mjs",
  "src/domain/decision/legacy-decision-projection.mjs",
  "src/domain/decision/native-decision-authority.mjs",
  "src/domain/decision/native-host-answer-authority.mjs",
];

const FORBIDDEN_DECISION_DEPENDENCIES = [
  "run-meta-theory-governed-execution",
  "select-execution-route",
  "plan-challenge",
  "choice-policy",
  "card-plan",
  "runtime-capability-acceptance",
  "runtime-execution-gate",
  "current-host-execution-authority",
  "durable-run-kernel",
  "setup.mjs",
  "sync-runtimes",
  "sync-global-meta-theory",
  "runtime-assets",
  "project-capability-copy",
];

function decisionFixture(overrides = {}) {
  return {
    identity: {
      runId: "run:m3-native-boundary",
      taskFingerprint: "digest:m3-native-boundary",
      decisionKey: "decision:scope-choice",
      scopeRef: "scope:m3-native-boundary",
    },
    routeChangingDimensions: ["scope"],
    evidence: [{ evidenceRef: "evidence:source-read", digest: "digest:m3-native-boundary" }],
    options: [
      {
        optionId: "option:contained",
        displayRef: "display:contained",
        tradeoffRefs: ["tradeoff:lower-risk"],
        evidenceRefs: ["evidence:source-read"],
      },
      {
        optionId: "option:expanded",
        displayRef: "display:expanded",
        tradeoffRefs: ["tradeoff:more-coverage"],
        evidenceRefs: ["evidence:source-read"],
      },
    ],
    recommendation: {
      optionId: "option:contained",
      rationaleRef: "reason:preserve-legacy-authority",
      evidenceRefs: ["evidence:source-read"],
    },
    requirement: {
      required: true,
      reasonRef: "reason:route-changing-choice",
      evidenceRefs: ["evidence:source-read"],
    },
    nativeSurface: { runtime: "codex", surface: "request_user_input", primary: true },
    createdAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

function presentedDecision() {
  return presentDecision(createDecision(decisionFixture()), { at: "2026-08-09T00:01:00.000Z" });
}

function codexClaim(decision, overrides = {}) {
  return buildHostAnswerClaim(decision, {
    source: "codex_request_user_input",
    requestRef: "request:m3-native-boundary",
    claimRef: "claim:m3-native-boundary",
    issuedAt: "2026-08-09T00:01:10.000Z",
    expiresAt: "2026-08-09T00:02:10.000Z",
    claimedAt: "2026-08-09T00:01:20.000Z",
    selectedOptionId: "option:contained",
    answerDigest: "digest:m3-native-answer",
    ...overrides,
  });
}

test("Wave A Decision sources are pure and isolated from legacy, runtime, lifecycle, and projection writers", () => {
  for (const relativePath of DECISION_SOURCE_FILES) {
    const absolutePath = path.resolve(relativePath);
    assert.equal(existsSync(absolutePath), true, `missing explicit pre-package closure candidate ${relativePath}`);
    const source = readFileSync(absolutePath, "utf8");
    const importSpecifiers = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/gu)].map((match) => match[1]);
    for (const forbidden of FORBIDDEN_DECISION_DEPENDENCIES) {
      assert.equal(
        importSpecifiers.some((specifier) => specifier.includes(forbidden)),
        false,
        `${relativePath} must not import ${forbidden}`,
      );
    }
    assert.doesNotMatch(source, /(?:node:fs|node:child_process|node:net|node:http|node:https|node:process)/u, `${relativePath} must not import I/O or process authority`);
  }

  const runner = readFileSync(path.resolve("scripts/run-meta-theory-governed-execution.mjs"), "utf8");
  assert.doesNotMatch(
    runner,
    /(?:src\/domain\/decision|legacy-decision-projection|native-host-answer|app-server-decision-host-adapter|sdk-decision-host-adapter)/u,
    "M3-P2 must leave the governed runner unwired from Decision host-answer authority",
  );
});

test("M3-P2 keeps Domain pure and places filesystem persistence only in the Data repository", () => {
  for (const relativePath of PURE_DECISION_DOMAIN) {
    const source = readFileSync(path.resolve(relativePath), "utf8");
    assert.doesNotMatch(
      source,
      /(?:node:(?:fs(?:\/promises)?|process|child_process|net|http|https|dns|tls|dgram)|(?:\.\.\/)+(?:data\/|adapters\/|scripts\/))/u,
      `${relativePath} must remain a pure Domain module`,
    );
  }

  const repositorySource = readFileSync(path.resolve(HOST_ANSWER_REPOSITORY), "utf8");
  assert.match(repositorySource, /from\s+["']node:fs["']/u, "the Data repository owns filesystem I/O");
  assert.match(
    repositorySource,
    /from\s+["']\.\.\/\.\.\/domain\/decision\/native-host-answer-authority\.mjs["']/u,
    "the Data repository may depend inward on the Domain validator",
  );
});

test("M3-P2 runtime adapters depend on Domain plus an injected repository port, never the filesystem repository", () => {
  for (const { path: relativePath, injectedRepositoryPort } of HOST_RUNTIME_ADAPTERS) {
    const source = readFileSync(path.resolve(relativePath), "utf8");
    const importSpecifiers = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/gu)].map((match) => match[1]);

    assert.equal(
      importSpecifiers.some((specifier) => specifier.startsWith("../../domain/decision/")),
      true,
      `${relativePath} must depend inward on the Decision Domain`,
    );
    assert.equal(
      importSpecifiers.some((specifier) => specifier.includes("data/repositories")),
      false,
      `${relativePath} must receive a repository port instead of importing its filesystem implementation`,
    );
    assert.doesNotMatch(source, /node:fs|createNativeHostAnswerRepository/u, `${relativePath} must not own repository I/O`);
    assert.match(source, injectedRepositoryPort, `${relativePath} must use an injected repository port`);
  }
});

test("Decision host claims stay adapter-specific and cannot become generic receipt or authorization APIs", () => {
  assert.deepEqual(Object.keys(HOST_RECEIPT_ADAPTERS).sort(), [
    "claude_AskUserQuestion",
    "codex_request_user_input",
  ]);
  assert.notDeepEqual(
    HOST_RECEIPT_ADAPTERS.codex_request_user_input,
    HOST_RECEIPT_ADAPTERS.claude_AskUserQuestion,
    "Codex and Claude host adapters must remain distinct bindings",
  );

  const presented = presentedDecision();
  for (const source of [
    "runtime_capability_acceptance",
    "runtime_host_handoff",
    "current_host_execution_authority",
    "generic_receipt",
    "request_user_input",
  ]) {
    assert.throws(() => codexClaim(presented, { source }), /adapter|source|host/u, `${source} cannot mint a Decision claim`);
  }
  assert.throws(
    () => codexClaim(presented, { executionAuthorized: true }),
    /supported|input/u,
    "a claim may not smuggle execution authorization",
  );

  const claudeDecision = presentDecision(createDecision(decisionFixture({
    identity: { ...decisionFixture().identity, runId: "run:m3-native-boundary-claude" },
    nativeSurface: { runtime: "claude", surface: "AskUserQuestion", primary: true },
  })), { at: "2026-08-09T00:01:00.000Z" });
  assert.throws(
    () => codexClaim(claudeDecision),
    /native surface|adapter/u,
    "a Codex adapter cannot claim a Claude decision",
  );
});

test("current-host handoff, Decision gates, and compatibility projections remain non-authorizing", () => {
  for (const handoff of [
    resolveCurrentHostHandoff({ routeCompatible: false }),
    resolveCurrentHostHandoff({ routeCompatible: true, choiceRequired: true }),
    resolveCurrentHostHandoff({ routeCompatible: true, choiceRequired: false }),
  ]) {
    assert.equal(handoff.executionAuthorized, false);
  }

  const presented = presentedDecision();
  const claimed = claimHostAnswer(presented, {
    at: "2026-08-09T00:01:20.000Z",
    claim: codexClaim(presented),
  });
  assert.equal(decisionExecutionGate(claimed).executionAllowed, false);

  for (const projection of [
    buildCardPlanPacketDecisionProjection(claimed),
    buildPreDecisionOptionFrameProjection(claimed),
    buildRouteGateDecisionProjection(claimed),
  ]) {
    assert.equal(projection.executionAllowed ?? false, false);
    assert.equal(projection.decisionDomain?.cannotAuthorizeExecution ?? projection.cannotAuthorizeExecution, true);
  }
});

test("Wave A package closure names every Decision candidate and forbids a broad src package entry", () => {
  const packageManifest = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));
  assert.equal(packageManifest.files.some((entry) => /^src(?:\/|\/\*\*)?$/u.test(entry)), false, "never widen the package with src/ or src/**");
  assert.equal(
    packageManifest.files.some((entry) => entry.startsWith("src/") && entry.endsWith("/")),
    false,
    "every packaged src entry must be an explicit file, never an auto-expanding directory",
  );
  for (const relativePath of [...DECISION_SOURCE_FILES, HOST_ANSWER_REPOSITORY]) {
    assert.equal(packageManifest.files.includes(relativePath), true, `${relativePath} must be explicitly package-closed`);
  }
});
