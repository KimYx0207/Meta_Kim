import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { tarExtractCommand } from "../../scripts/tar-extract-command.mjs";

import {
  LIVE_SDK_VERSION,
  RUNTIME_ADAPTER_SCHEMA_VERSION,
  EVIDENCE_CARD_SCHEMA_VERSION,
  REPLAY_THEME_SCHEMA_VERSION,
  defineRuntimeAdapter,
  runRuntimeAdapter,
  assertValidRuntimeAdapterResult,
  defineEvidenceCard,
  buildEvidenceCard,
  assertValidEvidenceCard,
  defineReplayTheme,
  renderReplayTheme,
  assertValidReplayThemeFrame,
  SDK_AUTHORITY,
  SDK_CAPABILITIES,
} from "../../src/sdk/live/index.mjs";

import { adapter as externalAdapter } from "../../examples/live-sdk/adapter-example.mjs";
import { card as externalCard } from "../../examples/live-sdk/evidence-card-example.mjs";
import { theme as externalTheme } from "../../examples/live-sdk/replay-theme-example.mjs";

const PUBLIC_ENTRY = path.resolve("src/sdk/live/index.mjs");
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGE_REQUIRED_FILES = [
  "config/contracts/meta-kim-live-share-schema.json",
  "scripts/meta-kim-live.mjs",
  "src/domain/live/live-share-artifact.mjs",
  "src/domain/live/live-continuation-command.mjs",
  "src/application/live/build-live-share-artifact.mjs",
  "src/application/live/plan-live-continuation.mjs",
  "src/application/live/live-control-room-service.mjs",
  "src/infrastructure/live/live-continuation-command-store.mjs",
  "src/infrastructure/live/live-runtime-adapter-registry.mjs",
  "src/infrastructure/live/live-control-room-server.mjs",
  "src/infrastructure/live/live-hub-lifecycle.mjs",
  "src/infrastructure/live/live-hub-project-catalog.mjs",
  "src/infrastructure/live/live-read-repository.mjs",
  "src/presentation/live/render-live-share-card.mjs",
  "src/presentation/live/live-control-room-page.mjs",
  "src/sdk/live/common.mjs",
  "src/sdk/live/evidence-card.mjs",
  "src/sdk/live/index.mjs",
  "src/sdk/live/replay-theme.mjs",
  "src/sdk/live/runtime-adapter.mjs",
  "examples/live-sdk/adapter-example.mjs",
  "examples/live-sdk/evidence-card-example.mjs",
  "examples/live-sdk/replay-theme-example.mjs",
  "docs/live-sdk.md",
];

function npmCli() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function packMetadata({ destination, dryRun = true } = {}) {
  const args = ["pack", "--json", "--ignore-scripts"];
  if (dryRun) args.push("--dry-run");
  if (destination) args.push("--pack-destination", destination);
  const command = process.platform === "win32"
    ? [npmCli(), ...args].map((value) => /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value).join(" ")
    : null;
  const output = process.platform === "win32"
    ? execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
    : execFileSync(npmCli(), args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(output)[0];
}

function assertProjectionAuthority(value) {
  assert.deepEqual(value, SDK_AUTHORITY);
  assert.equal(value.authoritative, false);
  assert.equal(value.executionAllowed, false);
  assert.equal(value.mutationAllowed, false);
  assert.equal(value.liveCertified, false);
}

test("public Live SDK is versioned and exposes no runtime authority", () => {
  assert.match(LIVE_SDK_VERSION, /^\d+\.\d+\.\d+$/u);
  assert.equal(RUNTIME_ADAPTER_SCHEMA_VERSION, "meta-kim-live-runtime-adapter-v1");
  assert.equal(EVIDENCE_CARD_SCHEMA_VERSION, "meta-kim-live-evidence-card-v1");
  assert.equal(REPLAY_THEME_SCHEMA_VERSION, "meta-kim-live-replay-theme-v1");
  assert.equal(Object.isFrozen(SDK_AUTHORITY), true);
  assert.deepEqual(SDK_CAPABILITIES, ["normalize", "project"]);
  assertProjectionAuthority(SDK_AUTHORITY);
});

test("third-party adapter works through public SDK only and remains projection-only", async () => {
  const result = await runRuntimeAdapter(externalAdapter, {
    state: "running",
    phase: "Execution",
    observedAt: "2026-08-24T10:00:00.000Z",
  });
  assert.equal(result.schemaVersion, RUNTIME_ADAPTER_SCHEMA_VERSION);
  assert.equal(result.adapter.id, "example-runtime");
  assert.equal(result.observation.status, "running");
  assert.equal(result.observation.stage, "execution");
  assertProjectionAuthority(result.authority);
  assert.equal(result.capabilityDeclaration.authority, "self_declared_projection");
  assertValidRuntimeAdapterResult(result);
});

test("third-party evidence card and direct card builder satisfy the public contract", async () => {
  const card = await externalCard.build({
    testCount: 3,
    passed: 3,
    observedAt: "2026-08-24T10:00:00.000Z",
  });
  assert.equal(card.schemaVersion, EVIDENCE_CARD_SCHEMA_VERSION);
  assert.equal(card.type, "test");
  assert.equal(card.status, "pass");
  assertProjectionAuthority(card.authority);
  assertValidEvidenceCard(card);

  const direct = buildEvidenceCard({
    id: "external-direct",
    version: "1.0.0",
    type: "security",
    label: "Security scan",
    status: "in_doubt",
    summary: "No live scanner was invoked.",
    refs: ["scan:fixture"],
    observedAt: "2026-08-24T10:00:00.000Z",
  });
  assert.equal(direct.status, "in_doubt");
  assertProjectionAuthority(direct.authority);
  assertValidEvidenceCard(direct);
});

test("third-party replay theme renders safe structured frames through public SDK only", async () => {
  const frame = await renderReplayTheme(externalTheme, {
    sequence: 1,
    at: "2026-08-24T10:00:00.000Z",
    kind: "stage",
    nodeId: "execution",
    status: "running",
    label: "Execution started",
  });
  assert.equal(frame.schemaVersion, REPLAY_THEME_SCHEMA_VERSION);
  assert.equal(frame.theme.id, "example-replay-theme");
  assert.equal(frame.presentation.tone, "active");
  assertProjectionAuthority(frame.authority);
  assertValidReplayThemeFrame(frame);
});

test("definitions reject unknown fields, unsafe strings, and authority escalation", () => {
  assert.throws(() => defineRuntimeAdapter({
    id: "bad",
    version: "1.0.0",
    label: "Bad",
    capabilities: ["normalize"],
    normalize() {
      return {
        status: "running",
        stage: "execution",
        observedAt: "2026-08-24T10:00:00.000Z",
        summary: "ok",
        authority: { authoritative: true },
      };
    },
    authority: { authoritative: true },
  }), /unsupported|exact|authority/iu);

  assert.throws(() => defineEvidenceCard({
    id: "unsafe-card",
    version: "1.0.0",
    type: "test",
    label: "C:\\Users\\Kim\\secret.txt",
    capabilities: ["project"],
    build() { return { status: "pass", summary: "no" }; },
  }), /sensitive|path|label/iu);

  assert.throws(() => defineReplayTheme({
    id: "unsafe-theme",
    version: "1.0.0",
    label: "Unsafe",
    capabilities: ["project"],
    render() {
      return { title: "x", tone: "active", marker: "x", authoritative: true };
    },
  }), /capabilit|unsupported/iu);
});

test("adapter/card/theme execution boundaries timeout and cancel without mutation", async () => {
  const adapter = defineRuntimeAdapter({
    id: "boundary-runtime",
    version: "1.0.0",
    label: "Boundary Runtime",
    capabilities: ["normalize"],
    async normalize(input) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        status: input.state,
        stage: "execution",
        observedAt: input.observedAt,
        summary: "done",
      };
    },
  });
  const input = Object.freeze({ state: "running", observedAt: "2026-08-24T10:00:00.000Z" });
  await assert.rejects(
    runRuntimeAdapter(adapter, input, { timeoutMs: 5 }),
    (error) => error?.code === "LIVE_SDK_TIMEOUT",
  );
  assert.deepEqual(input, { state: "running", observedAt: "2026-08-24T10:00:00.000Z" });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runRuntimeAdapter(adapter, input, { signal: controller.signal }),
    (error) => error?.code === "LIVE_SDK_ABORTED",
  );
  await assert.rejects(runRuntimeAdapter(adapter, input, { timeoutMs: 5, unsupported: true }), /unsupported/iu);
});

test("malformed contributor outputs and forged runtime shape fail closed", async () => {
  const forgedAdapter = defineRuntimeAdapter({
    id: "forged-runtime",
    version: "1.0.0",
    label: "Forged Runtime",
    capabilities: ["normalize"],
    normalize() {
      return {
        status: "running",
        stage: "execution",
        observedAt: "2026-08-24T10:00:00.000Z",
        summary: "safe",
        authority: { authoritative: true },
      };
    },
  });
  await assert.rejects(
    runRuntimeAdapter(forgedAdapter, {}),
    /unsupported|authority/iu,
  );

  const missingObservation = defineEvidenceCard({
    id: "missing-observation",
    version: "1.0.0",
    type: "test",
    label: "Missing observation",
    capabilities: ["project"],
    build() {
      return { status: "pass", summary: "no timestamp" };
    },
  });
  await assert.rejects(missingObservation.build({}), /observedAt|required/iu);

  const forgedTheme = {
    schemaVersion: "old-replay-theme-v0",
    sdkVersion: LIVE_SDK_VERSION,
    id: "forged-theme",
    version: "1.0.0",
    label: "Forged theme",
    capabilityDeclaration: {
      schemaVersion: REPLAY_THEME_SCHEMA_VERSION,
      sdkVersion: LIVE_SDK_VERSION,
      capabilities: ["render"],
      authority: "self_declared_projection",
    },
    render() {
      return { title: "x", tone: "active", marker: "x" };
    },
  };
  const validFrame = {
    sequence: 1,
    at: "2026-08-24T10:00:00.000Z",
    kind: "stage",
    nodeId: "execution",
    status: "running",
    label: "start",
  };
  await assert.rejects(renderReplayTheme(forgedTheme, validFrame), /defined by defineReplayTheme|unsupported/iu);
});

test("compatibility contract uses only the documented entrypoint for all external examples", async () => {
  const entrySource = await readFile(PUBLIC_ENTRY, "utf8");
  assert.match(entrySource, /export/iu);
  for (const file of [
    "examples/live-sdk/adapter-example.mjs",
    "examples/live-sdk/evidence-card-example.mjs",
    "examples/live-sdk/replay-theme-example.mjs",
  ]) {
    const source = await readFile(path.resolve(file), "utf8");
    assert.match(source, /from\s+["']meta-kim\/live-sdk["']/u, file);
    assert.doesNotMatch(source, /from\s+["'](?:node:|\.\.\/\.\.\/src\/)/u, `${file} imports non-public SDK code`);
    assert.doesNotMatch(source, /(?:zcode|deepseek|qoder|trae|openai|anthropic)/iu, `${file} names an external runtime/model`);
  }
});

test("packed publication has an explicit L02/L03/L04 closure and a stable SDK subpath", async () => {
  const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  const sourceEntries = manifest.files.filter((entry) => entry.startsWith("src/"));
  assert.equal(sourceEntries.some((entry) => entry.endsWith("/") || entry.includes("*")), false, "source package entries must be explicit files");
  for (const required of PACKAGE_REQUIRED_FILES) {
    assert.ok(manifest.files.includes(required), `package.files is missing ${required}`);
  }
  assert.ok(manifest.exports?.["./live-sdk"], "package must expose the stable live-sdk subpath");
  assert.equal(manifest.exports["./live-sdk"], "./src/sdk/live/index.mjs");
  assert.ok(manifest.exports["./*"], "existing deep imports must remain available through the export map");

  const dryRun = packMetadata();
  const packedFiles = new Set(dryRun.files.map(({ path: filePath }) => filePath));
  for (const required of PACKAGE_REQUIRED_FILES) assert.ok(packedFiles.has(required), `dry-run package is missing ${required}`);
  assert.equal([...packedFiles].some((filePath) => /(?:^|\/)(?:task_plan|progress|findings)\.md$/u.test(filePath)), false);
  assert.equal([...packedFiles].some((filePath) => /(?:^|\/)\.meta-kim(?:\/|$)/u.test(filePath)), false);
  assert.equal([...packedFiles].some((filePath) => /ai-native-capability-gap-mvp-prd|prd.*\.md$/iu.test(filePath)), false);

  const temp = await mkdtemp(path.join(os.tmpdir(), "meta-kim-live-sdk-packed-"));
  try {
    const packed = packMetadata({ destination: temp, dryRun: false });
    const extraction = tarExtractCommand(path.join(temp, packed.filename), temp);
    execFileSync(extraction.command, extraction.args, {
      cwd: extraction.cwd,
      windowsHide: true,
    });
    await mkdir(path.join(temp, "consumer", "node_modules"), { recursive: true });
    await cp(path.join(temp, "package"), path.join(temp, "consumer", "node_modules", "meta-kim"), { recursive: true });
    const consumer = path.join(temp, "consumer");
    await writeFile(path.join(consumer, "verify-packed-sdk.mjs"), [
      'import { defineRuntimeAdapter, defineEvidenceCard, defineReplayTheme } from "meta-kim/live-sdk";',
      'import { adapter } from "meta-kim/examples/live-sdk/adapter-example.mjs";',
      'import { card } from "meta-kim/examples/live-sdk/evidence-card-example.mjs";',
      'import { theme } from "meta-kim/examples/live-sdk/replay-theme-example.mjs";',
      "if (typeof defineRuntimeAdapter !== \"function\" || typeof defineEvidenceCard !== \"function\" || typeof defineReplayTheme !== \"function\") process.exit(2);",
      "if (!adapter || !card || !theme) process.exit(3);",
    ].join("\n"), "utf8");
    const result = execFileSync(process.execPath, [path.join(consumer, "verify-packed-sdk.mjs")], {
      cwd: consumer,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result, "");
    assert.ok(await readFile(path.join(temp, "package", "docs", "live-sdk.md"), "utf8"));
    assert.ok(await readFile(path.join(temp, "package", "examples", "live-sdk", "adapter-example.mjs"), "utf8"));
    assert.ok(pathToFileURL(path.join(temp, "package", "src", "sdk", "live", "index.mjs")).href.startsWith("file:"));
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});
