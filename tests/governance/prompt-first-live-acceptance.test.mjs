import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const scriptPath = path.join(
  repoRoot,
  "scripts",
  "run-prompt-first-full-flow-live-acceptance.mjs",
);
const artifactDir = path.join(
  ".meta-kim",
  "state",
  "default",
  "prompt-first-full-flow-live-acceptance",
);
const liveContractPath = path.join(
  repoRoot,
  "config",
  "contracts",
  "prompt-first-live-acceptance-contract.json",
);

function createSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meta-kim-prompt-first-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relativePath of [
    "scripts/run-prompt-first-full-flow-live-acceptance.mjs",
    "config/contracts/prompt-first-full-flow-stage-contract.json",
    "config/contracts/prompt-first-live-acceptance-contract.json",
  ]) {
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relativePath), destination);
  }
  fs.writeFileSync(path.join(root, "scripts/eval-meta-agents.mjs"),
    'throw new Error("Actual evaluator/auth preparation must never run in this test");\n');
  const home = path.join(root, "empty-home");
  const temp = path.join(root, "temp");
  fs.mkdirSync(home);
  fs.mkdirSync(temp);
  const tracePath = path.join(root, "attempts.jsonl");
  const guardPath = path.join(root, "guard.cjs");
  fs.writeFileSync(guardPath, String.raw`
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const log = (entry) => fs.appendFileSync(process.env.TEST_TRACE, JSON.stringify(entry) + "\n");
const deny = (operation) => (...args) => {
  log({ blocked: operation });
  throw new Error("Unexpected external/auth access: " + operation);
};
for (const name of ["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"]) {
  cp[name] = deny("child_process." + name);
}
for (const moduleName of ["http", "https"]) {
  const module = require("node:" + moduleName);
  module.request = deny(moduleName + ".request");
  module.get = deny(moduleName + ".get");
}
require("node:net").Socket.prototype.connect = deny("net.connect");
require("node:tls").connect = deny("tls.connect");
globalThis.fetch = deny("fetch");
for (const module of [fs, fs.promises]) {
  for (const name of ["readFile", "readFileSync", "readdir", "readdirSync", "open", "openSync", "access", "accessSync", "stat", "statSync"]) {
    if (typeof module[name] !== "function") continue;
    const original = module[name];
    module[name] = function (file, ...args) {
      if (typeof file === "string") {
        const relative = path.relative(process.env.HOME, path.resolve(file));
        if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
          return deny("home/auth." + name)();
        }
      }
      return original.call(this, file, ...args);
    };
  }
}
if (process.env.TEST_MOCK_PAYLOADS) {
  const payloads = JSON.parse(fs.readFileSync(process.env.TEST_MOCK_PAYLOADS, "utf8"));
  cp.spawn = (file, args, options) => {
    let output;
    let exitCode = 0;
    if (file === "test-claude") {
      output = JSON.stringify({ structured_output: payloads.claude_code });
    } else if (file === "test-codex") {
      output = JSON.stringify({ type: "item.completed", item: {
        type: "agent_message", text: JSON.stringify(payloads.codex),
      }});
    } else if (file === process.execPath && path.basename(args[0]) === "eval-meta-agents.mjs") {
      const runtime = args[1].split("=")[1];
      const status = runtime === "openclaw" ? (process.env.TEST_SMOKE_STATUS || "passed") : "passed";
      output = JSON.stringify({ [runtime]: {
        status, ok: status === "passed", failureClass: status === "passed" ? "pass" : "test_smoke_blocked",
        remainingAction: status === "passed" ? "none" : "Resolve mocked smoke blocker",
      }});
      exitCode = status === "passed" ? 0 : 1;
    } else {
      return deny("unexpected mocked command")();
    }
    const child = new EventEmitter();
    let stdin;
    child.stdin = { end: (text) => { stdin = text; } };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = deny("mock.kill");
    queueMicrotask(() => {
      log({ file, args, cwd: options.cwd, stdin });
      child.stdout.end(output + "\n");
      child.stderr.end();
      child.emit("close", exitCode);
    });
    return child;
  };
}
require("node:module").syncBuiltinESMExports();
`);
  const env = {
    PATH: path.dirname(process.execPath),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    TEST_TRACE: tracePath,
    META_KIM_CLAUDE_BIN: "test-claude",
    META_KIM_CODEX_BIN: "test-codex",
  };
  for (const key of ["SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const commandArgs = ["--require", guardPath, path.join(root, "scripts", path.basename(scriptPath))];
  return {
    root, home, tracePath, env, commandArgs,
    run: (...args) => execFileSync(process.execPath, [...commandArgs, ...args], {
      cwd: root, env, encoding: "utf8", timeout: 15_000,
    }),
    readArtifact: (name = "latest.fixture.json") => JSON.parse(
      fs.readFileSync(path.join(root, artifactDir, name), "utf8"),
    ),
    readTrace: () => fs.existsSync(tracePath)
      ? fs.readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      : [],
  };
}

function prepareMockLiveRun(sandbox) {
  sandbox.run("--fixture");
  const payloads = sandbox.readArtifact().runtimeResults;
  for (const payload of Object.values(payloads)) {
    for (const evidence of payload.workerExecutionEvidence) evidence.evidenceKind = "runtime_live_pass";
    payload.verificationResult.evidenceKind = "runtime_live_pass";
    payload.claimBoundary.liveExecutionPass = true;
    payload.claimBoundary.releaseGradeFullFlowClaim = true;
  }
  const payloadPath = path.join(sandbox.root, "mock-live-payloads.json");
  fs.writeFileSync(payloadPath, JSON.stringify(payloads));
  sandbox.env.TEST_MOCK_PAYLOADS = payloadPath;
}

test("prompt-first fixture is local and credential-free without claiming live or compatibility smoke pass", (t) => {
  const sandbox = createSandbox(t);
  const stdout = sandbox.run("--fixture");
  assert.match(stdout, /prompt-first full-flow fixture acceptance valid/);
  assert.match(stdout, /P-087=fixture_pass_not_live/);
  assert.match(stdout, /P-088=fixture_pass_not_live/);
  assert.match(stdout, /compatibilitySmoke=openclaw:fixture_pass_not_live,cursor:fixture_pass_not_live/);
  assert.match(stdout, /latest\.fixture\.json/);

  const artifact = sandbox.readArtifact();
  assert.equal(artifact.mode, "fixture");
  assert.deepEqual(artifact.compatibilitySmokeRuntimes, ["openclaw", "cursor"]);
  for (const runtime of ["openclaw", "cursor"]) {
    const result = artifact.compatibilitySmokeResults[runtime];
    assert.equal(result.mode, "fixture");
    assert.equal(result.status, "fixture_pass_not_live");
    assert.equal(result.evidenceKind, "fixture_regression");
    assert.equal(result.fixtureOnly, true);
    assert.equal(result.actualHostObserved, false);
    assert.equal(result.compatibilitySmokeClaimAllowed, false);
    assert.equal(result.primaryLiveClaimAllowed, false);
    assert.equal(result.exitCode, undefined);
    assert.deepEqual(result.sample, { runtime, mode: "fixture", status: "passed", ok: true });
    assert.match(result.fixtureSource, /#compatibilitySmokeFixtureInputs$/);
  }
  assert.equal(artifact.compatibilitySmokePacket.status, "pass");
  assert.equal(artifact.compatibilitySmokePacket.evidenceKind, "fixture_regression");
  assert.equal(artifact.compatibilitySmokePacket.fixtureOnly, true);
  assert.equal(artifact.compatibilitySmokePacket.compatibilitySmokeClaimAllowed, false);
  assert.equal(artifact.compatibilitySmokePacket.primaryLiveClaimAllowed, false);
  assert.equal(artifact.summary.fixtureModeCannotClaimLivePass, true);
  assert.equal(artifact.summary.fixtureModeCannotClaimCompatibilitySmokePass, true);
  assert.deepEqual(artifact.summary.liveRuntimesPassed, []);
  assert.equal(artifact.summary.primaryRuntimePerfection, false);
  assert.equal(artifact.prdTaskStatuses["P-089"], "pass");
  assert.equal(artifact.prdTaskStatuses["P-090"], "pass");
  assert.equal(artifact.prdTaskStatuses["P-091"], "pass");

  for (const runtime of ["claude_code", "codex"]) {
    const payload = artifact.runtimeResults[runtime];
    assert.equal(payload.claimBoundary.liveExecutionPass, false);
    assert.equal(payload.claimBoundary.releaseGradeFullFlowClaim, false);
    assert.equal(payload.verificationResult.evidenceKind, "fixture_regression");
    assert.equal(payload.reviewPacket.depthStrategy.evidenceQualityChecked, true);
    assert.equal(payload.reviewPacket.depthStrategy.counterEvidenceChecked, true);
    assert.equal(payload.reviewPacket.depthStrategy.decisionImpactChecked, true);
    assert.equal(payload.reviewPacket.depthStrategy.falsificationChecked, true);
    assert.deepEqual(payload.reviewPacket.depthStrategy.upstreamStageTrace, [
      "critical",
      "fetch",
      "thinking",
      "execution",
    ]);
    assert.equal(payload.metaReviewPacket.reviewDepthAudit.shallowPacketPassRejected, true);
    assert.equal(payload.metaReviewPacket.reviewDepthAudit.adversarialCoverageChecked, true);
    assert.equal(payload.evolutionWritebackPacket.strategy.reusablePatternAssessed, true);
    assert.equal(payload.evolutionWritebackPacket.strategy.writebackTargetAssessed, true);
    assert.equal(payload.evolutionWritebackPacket.strategy.scarNeedAssessed, true);
    assert.equal(
      payload.evolutionWritebackPacket.strategy.nextRunReuseKey,
      "prompt-first-live-depth-gate",
    );
  }
  assert.deepEqual(sandbox.readTrace(), [], "fixture must not start any subprocess, network, or auth lookup");
  assert.deepEqual(fs.readdirSync(sandbox.home), []);
  for (const name of ["latest.json", "latest.live.json"]) {
    assert.equal(fs.existsSync(path.join(sandbox.root, artifactDir, name)), false);
  }
});

test("prompt-first compatibility fixtures reject host/smoke/live claim promotion", (t) => {
  const sandbox = createSandbox(t);
  assert.match(sandbox.run("--self-test-compatibility-fixture-boundary"), /compatibility fixture boundary self-test passed/);
  assert.deepEqual(sandbox.readTrace(), []);
});

for (const flags of [["--live"], []]) {
  test(`prompt-first ${flags.length ? "explicit" : "default"} live mode still invokes primary CLIs and actual smoke command paths (mocked)`, (t) => {
    const sandbox = createSandbox(t);
    prepareMockLiveRun(sandbox);
    assert.match(sandbox.run(...flags), /prompt-first full-flow live acceptance valid/);
    const calls = sandbox.readTrace();
    assert.equal(calls.length, 4);
    assert.equal(calls[0].file, "test-claude");
    assert.deepEqual(calls[0].args.slice(0, 5), ["-p", "--output-format", "json", "--agent", "meta-warden"]);
    assert.equal(calls[1].file, "test-codex");
    assert.deepEqual(calls[1].args.slice(0, 5), ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only"]);
    assert.match(calls[1].stdin, /Use this exact frameworkPromptPacket/);
    for (const [index, runtime] of ["openclaw", "cursor"].entries()) {
      assert.equal(calls[index + 2].file, process.execPath);
      assert.deepEqual(calls[index + 2].args, [path.join(sandbox.root, "scripts/eval-meta-agents.mjs"), `--runtime=${runtime}`]);
    }
    const artifact = sandbox.readArtifact("latest.live.json");
    assert.equal(artifact.mode, "live");
    assert.equal(artifact.summary.primaryRuntimePerfection, true);
    assert.deepEqual(artifact.summary.liveRuntimesPassed, ["claude_code", "codex"]);
    assert.equal(artifact.compatibilitySmokePacket.evidenceKind, "compatibility_smoke_pass");
    assert.equal(artifact.compatibilitySmokePacket.fixtureOnly, false);
    assert.equal(artifact.compatibilitySmokePacket.primaryLiveClaimAllowed, false);
    for (const result of Object.values(artifact.compatibilitySmokeResults)) {
      assert.equal(result.mode, "smoke");
      assert.equal(result.status, "passed");
      assert.equal(result.evidenceKind, "compatibility_smoke_pass");
      assert.equal(result.exitCode, 0);
      assert.equal(result.fixtureSource, undefined);
    }
  });
}

for (const status of ["failed", "needsAuth"]) {
  test(`prompt-first live mode still blocks ${status} compatibility smoke (mocked)`, (t) => {
    const sandbox = createSandbox(t);
    prepareMockLiveRun(sandbox);
    sandbox.env.TEST_SMOKE_STATUS = status;
    const result = spawnSync(process.execPath, [...sandbox.commandArgs, "--live"], {
      cwd: sandbox.root, env: sandbox.env, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(sandbox.readTrace().length, 4);
    const artifact = sandbox.readArtifact("latest.live.json");
    assert.equal(artifact.summary.status, "fail");
    assert.deepEqual(artifact.summary.liveRuntimesPassed, []);
    assert.equal(artifact.summary.primaryRuntimePerfection, false);
    assert.equal(artifact.compatibilitySmokePacket.status, "fail");
    assert.equal(artifact.compatibilitySmokeResults.openclaw.status, status);
    assert.equal(artifact.compatibilitySmokeResults.openclaw.evidenceKind, "compatibility_smoke_failed");
  });
}

test("prompt-first rejects contradictory fixture/live flags before touching a runtime or artifact", (t) => {
  const sandbox = createSandbox(t);
  const result = spawnSync(process.execPath, [...sandbox.commandArgs, "--fixture", "--live"], {
    cwd: sandbox.root, env: sandbox.env, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--fixture and --live are mutually exclusive/);
  assert.deepEqual(sandbox.readTrace(), []);
  assert.equal(fs.existsSync(path.join(sandbox.root, artifactDir)), false);
});

test("prompt-first live normalization does not synthesize Review Meta-Review or Evolution pass packets", (t) => {
  const sandbox = createSandbox(t);
  const stdout = sandbox.run("--self-test-strict-live-normalization");
  assert.match(stdout, /strict live normalization self-test passed/);
});

test("prompt-first live contract requires deep Review Meta-Review and Evolution strategy", () => {
  const contract = JSON.parse(fs.readFileSync(liveContractPath, "utf8"));
  assert.ok(contract.depthQuality, "live acceptance contract must define depthQuality");
  assert.deepEqual(contract.depthQuality.reviewPacket.requiredUpstreamStageTrace, [
    "critical",
    "fetch",
    "thinking",
    "execution",
  ]);
  for (const field of [
    "evidenceQualityChecked",
    "counterEvidenceChecked",
    "decisionImpactChecked",
    "falsificationChecked",
  ]) {
    assert.ok(contract.depthQuality.reviewPacket.requiredDepthStrategyFields.includes(field));
  }
  for (const field of [
    "shallowPacketPassRejected",
    "adversarialCoverageChecked",
    "reviewBlindSpotChecked",
    "publicReadyEvidenceSeparated",
  ]) {
    assert.ok(contract.depthQuality.metaReviewPacket.requiredReviewDepthAuditFields.includes(field));
  }
  assert.ok(
    contract.depthQuality.evolutionWritebackPacket.requiredStrategyFields.includes(
      "nextRunReuseKey",
    ),
  );
});
