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
  for (const [label, task] of [
    ["default diagnostic entry", null],
    ["single natural-language entry", "这个任务需要把重复出现的 PRD review standard 沉淀成可复用 skill candidate。"],
  ]) {
    test(`${label} preserves a resumable preparation instead of inferring completed work`, async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-complete-product-"));
      try {
        const jsonPath = path.join(tempDir, "product.json");
        const markdownPath = path.join(tempDir, "product.md");
        const dbPath = path.join(tempDir, "product.sqlite");
        const report = await runCapabilityGapCompleteProduct({ jsonPath, markdownPath, dbPath, task });
        assert.equal(report.artifactKind, "host_preparation");
        assert.equal(report.status, "partial");
        assert.equal(report.preparation.status, "needs_thinking");
        assert.equal(report.summary.mode, "host_preparation");
        assert.equal(report.summary.consumer, "capability_gap_complete_product");
        assert.equal(report.nextAction.stage, "Critical");
        assert.equal(report.nextAction.producer, "current_host_ai");
        assert.deepEqual(report.workerTaskPackets, []);
        assert.equal(report.coreLoop.stageDagPacket, undefined);
        assert.equal(report.publicReadyDecision.publicReady, false);
        for (const field of ["productArtifacts", "scorecards", "graphValidation", "aiReadableStandards"]) {
          assert.equal(report[field], undefined, `${field} cannot be synthesized from task keywords`);
        }
        if (task) assert.equal(report.task, task);
        for (const file of [jsonPath, markdownPath, report.paths.json, report.paths.markdown]) {
          assert.ok((await stat(file)).size > 0);
        }
        const saved = JSON.parse(await readFile(jsonPath, "utf8"));
        assert.equal(saved.preparation.bindingDigest, report.preparation.bindingDigest);
        const markdown = await readFile(markdownPath, "utf8");
        assert.equal(markdown, await readFile(report.paths.markdown, "utf8"));
        assert.match(markdown, /needs_thinking/u);
        assert.match(markdown, /尚未形成正式执行工单/u);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  }

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
