import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertExactRuntimeCapabilityMatrix,
  parseRuntimeCapabilityMatrix,
  readRequiredPackagedText,
  validateRequiredMarkdown,
  validateRuntimeCapabilityMatrix,
} from "../../scripts/mcp/runtime-resource-contract.mjs";

const matrixPath = "config/runtime-capability-matrix.json";
const canonicalMatrix = JSON.parse(readFileSync(matrixPath, "utf8"));

test("MCP runtime resources use packaged canonical files without fallback stubs", () => {
  const source = readFileSync("scripts/mcp/meta-runtime-server.mjs", "utf8");
  assert.match(source, /packagedCanonicalAgentsDir = path\.join\(repoRoot, "canonical", "agents"\)/u);
  assert.match(source, /"canonical",\s*"skills",\s*"meta-theory",\s*"SKILL\.md"/u);
  assert.match(source, /"config",\s*"runtime-capability-matrix\.json"/u);
  assert.doesNotMatch(
    source,
    /FALLBACK_META_THEORY|readUtf8IfExists|openclawSkillPath|canonicalAgentsDir/u,
  );
});

test("MCP packaged resources ignore a polluted repository-root environment", () => {
  const externalRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-mcp-external-root-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["scripts/mcp/meta-runtime-server.mjs", "--self-test"],
      {
        cwd: process.cwd(),
        env: { ...process.env, META_KIM_REPO_ROOT: externalRoot },
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.agentCount, 9);
    assert.equal(payload.tools.length, 7);
    assert.ok(payload.tools.includes("calculate_materials"));
    assert.deepEqual(payload.resources.slice(-2), ["meta://runtime-effective", "meta://skill/meta-theory"]);
  } finally {
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("MCP empty effective status returns results0 and exact missing10 without execution authority", () => {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-mcp-empty-effective-"));
  try {
    mkdirSync(path.join(projectRoot, ".meta-kim", "state", "default"), { recursive: true });
    writeFileSync(path.join(projectRoot, ".meta-kim", "state", "default", "project-bootstrap.json"), "{}\n", "utf8");
    const result = spawnSync(process.execPath, ["scripts/mcp/meta-runtime-server.mjs", "--effective-runtime-self-test"], {
      cwd: process.cwd(),
      env: { ...process.env, META_KIM_CALLER_CWD: projectRoot },
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
    const payload = JSON.parse(result.stdout);
    assert.ok(payload.matrix, "fresh packaged evidence must not silently become a blocked/null matrix");
    assert.notEqual(payload.overlayStatus.state, "blocked");
    assert.deepEqual(payload.results, []);
    assert.equal(payload.missing.length, 10);
    assert.equal(new Set(payload.missing.map((entry) => `${entry.runtime}:${entry.capability}:${entry.mode}`)).size, 10);
    assert.equal(payload.executionAuthority, false);
    assert.equal(payload.observedInCurrentRun, false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("required packaged resources fail closed when missing", async () => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "meta-kim-mcp-required-")));
  try {
    await assert.rejects(
      readRequiredPackagedText(path.join(root, "missing.md"), {
        packageRoot: root,
        label: "required test resource",
      }),
      /ENOENT|no such file/iu,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packaged resource reads accept plain filesystem aliases but enforce lexical package containment", async (context) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "meta-kim-mcp-plain-alias-"));
  const root = process.platform === "win32" ? temporary : realpathSync.native(temporary);
  context.after(() => rmSync(temporary, { recursive: true, force: true }));
  const packageRoot = path.join(root, "Package 资料 Space");
  mkdirSync(packageRoot);
  const resource = path.join(packageRoot, "resource.md");
  writeFileSync(resource, "# Packaged fixture\n");
  try {
    assert.equal(await readRequiredPackagedText(resource, { packageRoot }), "# Packaged fixture\n");
  } catch (error) {
    // Only fixed-fixture numeric metadata is exposed, never paths or contents.
    const observe = (stat) => Object.fromEntries([
      ...["dev", "ino", "size", "mtimeNs"].map((key) => [key, String(stat[key])]),
      ["regularFile", stat.isFile()],
    ]);
    let diagnostic;
    try {
      const pathStat = await fs.lstat(resource, { bigint: true });
      const diagnosticHandle = await fs.open(resource, "r");
      try {
        diagnostic = { node: process.versions.node, platform: process.platform, pathStat: observe(pathStat), handleStat: observe(await diagnosticHandle.stat({ bigint: true })) };
      } finally { await diagnosticHandle.close(); }
    } catch { diagnostic = { status: "fixture_identity_diagnostic_unavailable" }; }
    error.message += ` Fixture identity diagnostic: ${JSON.stringify(diagnostic).slice(0, 1024)}`;
    throw error;
  }
  const outside = path.join(root, "outside.md");
  writeFileSync(outside, "# Outside\n");
  await assert.rejects(readRequiredPackagedText(outside, { packageRoot }), /could not be read safely/u);
  assert.equal(readFileSync(outside, "utf8"), "# Outside\n");
});

test("packaged resource reads reject a linked ancestor of a plain package root", async (context) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "meta-kim-mcp-root-ancestor-"));
  const root = realpathSync.native(temporary);
  context.after(() => rmSync(temporary, { recursive: true, force: true }));
  const physical = path.join(root, "physical");
  const packageRoot = path.join(physical, "package");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, "resource.md"), "# Retained\n");
  const linked = path.join(root, "linked");
  symlinkSync(physical, linked, process.platform === "win32" ? "junction" : "dir");
  const linkedRoot = path.join(linked, "package");
  await assert.rejects(readRequiredPackagedText(path.join(linkedRoot, "resource.md"), { packageRoot: linkedRoot }), /could not be read safely/u);
  assert.equal(readFileSync(path.join(packageRoot, "resource.md"), "utf8"), "# Retained\n");
});

test("packaged resource reads reject linked parent chains and redact absolute paths", async (context) => {
  if (process.platform !== "win32") return context.skip("Windows junction containment reproduction");
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-mcp-root-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "meta-kim-mcp-outside-"));
  try {
    writeFileSync(path.join(outside, "resource.md"), "# Outside\n", "utf8");
    mkdirSync(path.join(root, "nested"), { recursive: true });
    rmSync(path.join(root, "nested"), { recursive: true, force: true });
    symlinkSync(outside, path.join(root, "nested"), "junction");
    await assert.rejects(
      readRequiredPackagedText(path.join(root, "nested", "resource.md"), { packageRoot: root, label: "linked resource" }),
      (error) => {
        assert.doesNotMatch(error.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
        assert.doesNotMatch(error.message, new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
        return /could not be read safely/u.test(error.message);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("packaged resource reader uses one content-reading handle with before/after stability checks", () => {
  const source = readFileSync("scripts/mcp/runtime-resource-contract.mjs", "utf8");
  assert.match(source, /const before = await handle\.stat\(\{ bigint: true \}\)/u);
  assert.match(source, /const text = await handle\.readFile\("utf8"\)/u);
  assert.match(source, /const after = await handle\.stat\(\{ bigint: true \}\)/u);
  assert.equal([...source.matchAll(/\.readFile\(/gu)].length, 1);
  assert.doesNotMatch(source, /verificationHandle\.readFile/u);
});

function identityFixture(context) {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "meta-kim-mcp-identity-")));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "resource.md");
  writeFileSync(file, "# Identity fixture\n");
  return { root, file };
}

test("resource identity allows only Windows cross-API device representation differences", { concurrency: false }, async (context) => {
  const { root, file } = identityFixture(context);
  const open = fs.open.bind(fs);
  let opened = 0, closed = 0, contentReads = 0;
  context.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args); opened += 1;
    const stat = handle.stat.bind(handle), close = handle.close.bind(handle), read = handle.readFile.bind(handle);
    handle.stat = async (...options) => { const value = await stat(...options); value.dev += 1n << 40n; return value; };
    handle.close = async () => { closed += 1; return close(); };
    handle.readFile = async (...options) => { contentReads += 1; return read(...options); };
    return handle;
  });
  if (process.platform === "win32") {
    assert.equal(await readRequiredPackagedText(file, { packageRoot: root }), "# Identity fixture\n");
    assert.equal(opened, 2);
    assert.equal(contentReads, 1, "only the original content handle may read bytes");
  } else {
    await assert.rejects(readRequiredPackagedText(file, { packageRoot: root }), /could not be read safely/u);
    assert.equal(contentReads, 0, "POSIX cross-API device mismatch must fail before content is read");
  }
  assert.equal(closed, opened, "all opened identity handles must close");
});

test("resource identity rejects distinct BigInt inode values that Number would round together", { concurrency: false }, async (context) => {
  const { root, file } = identityFixture(context);
  const lstat = fs.lstat.bind(fs), open = fs.open.bind(fs);
  const pathInode = 1n << 60n, handleInode = pathInode + 1n;
  assert.equal(Number(pathInode), Number(handleInode));
  context.mock.method(fs, "lstat", async (...args) => { const value = await lstat(...args); value.ino = pathInode; return value; });
  let closed = false;
  context.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args), stat = handle.stat.bind(handle), close = handle.close.bind(handle);
    handle.stat = async (...options) => { const value = await stat(...options); value.ino = handleInode; return value; };
    handle.close = async () => { closed = true; return close(); };
    return handle;
  });
  await assert.rejects(readRequiredPackagedText(file, { packageRoot: root }), /could not be read safely/u);
  assert.equal(closed, true);
});

for (const family of ["path", "handle"]) {
  test(`resource identity rejects a device change within the ${family} metadata API family`, { concurrency: false }, async (context) => {
    const { root, file } = identityFixture(context);
    if (family === "path") {
      const lstat = fs.lstat.bind(fs); let calls = 0;
      context.mock.method(fs, "lstat", async (...args) => {
        const value = await lstat(...args);
        if (path.resolve(args[0]) === file && ++calls === 2) value.dev += 1n;
        return value;
      });
    } else {
      const open = fs.open.bind(fs);
      context.mock.method(fs, "open", async (...args) => {
        const handle = await open(...args), stat = handle.stat.bind(handle); let calls = 0;
        handle.stat = async (...options) => { const value = await stat(...options); if (++calls === 2) value.dev += 1n; return value; };
        return handle;
      });
    }
    await assert.rejects(readRequiredPackagedText(file, { packageRoot: root }), /could not be read safely/u);
  });
}

test("resource verification rejects a replacement handle for another real file with identical contents", { concurrency: false }, async (context) => {
  const { root, file } = identityFixture(context);
  const replacement = path.join(root, "different-resource.md");
  writeFileSync(replacement, readFileSync(file));
  const open = fs.open.bind(fs);
  let opened = 0, closed = 0;
  context.mock.method(fs, "open", async (filePath, ...args) => {
    const handle = await open(++opened === 2 ? replacement : filePath, ...args);
    const close = handle.close.bind(handle);
    handle.close = async () => { closed += 1; return close(); };
    return handle;
  });
  await assert.rejects(readRequiredPackagedText(file, { packageRoot: root }), /could not be read safely/u);
  assert.equal(opened, 2);
  assert.equal(closed, opened, "the content and verification handles both close on mismatch");
});

test("resource identity rejects a real file replacement between plain inspection and the canonical path snapshot", { concurrency: false }, async (context) => {
  const { root, file } = identityFixture(context);
  const replacement = path.join(root, "replacement.md");
  writeFileSync(replacement, readFileSync(file));
  const lstat = fs.lstat.bind(fs), open = fs.open.bind(fs);
  assert.notEqual((await lstat(file, { bigint: true })).ino, (await lstat(replacement, { bigint: true })).ino);
  let pathCalls = 0, opened = 0;
  context.mock.method(fs, "lstat", async (...args) => {
    if (++pathCalls === 2) renameSync(replacement, file);
    return lstat(...args);
  });
  context.mock.method(fs, "open", async (...args) => { opened += 1; return open(...args); });
  await assert.rejects(readRequiredPackagedText(file, { packageRoot: root }), /could not be read safely/u);
  assert.equal(opened, 0, "a replacement after the first observed identity must fail before open");
});

test("canonical MCP Markdown resources must remain structurally valid", () => {
  const theory = readFileSync(
    "canonical/skills/meta-theory/references/meta-theory.md",
    "utf8",
  );
  const skill = readFileSync("canonical/skills/meta-theory/SKILL.md", "utf8");
  assert.equal(validateRequiredMarkdown(theory), theory);
  assert.equal(
    validateRequiredMarkdown(skill, {
      requireFrontmatter: true,
      expectedFrontmatterName: "meta-theory",
    }),
    skill,
  );
  assert.throws(() => validateRequiredMarkdown(""), /valid non-empty Markdown/u);
  assert.throws(
    () => validateRequiredMarkdown("# Skill\n", { requireFrontmatter: true }),
    /missing YAML frontmatter/u,
  );
});

test("runtime matrix validation rejects incomplete and malicious payloads", () => {
  assert.equal(validateRuntimeCapabilityMatrix(canonicalMatrix, matrixPath), canonicalMatrix);
  assert.equal(canonicalMatrix.schemaVersion, 2);

  const missingMetadata = structuredClone(canonicalMatrix);
  delete missingMetadata.generatedFrom;
  assert.throws(
    () => validateRuntimeCapabilityMatrix(missingMetadata, "missing metadata"),
    /not a valid Meta_Kim runtime capability matrix/u,
  );

  const missingCapability = structuredClone(canonicalMatrix);
  missingCapability.platforms[0].capabilities.pop();
  assert.throws(
    () => validateRuntimeCapabilityMatrix(missingCapability, "missing capability"),
    /missing capabilities/u,
  );

  const legacyTimestamp = structuredClone(canonicalMatrix);
  legacyTimestamp.lastVerifiedAt = legacyTimestamp.lastReviewedAt;
  assert.throws(
    () => validateRuntimeCapabilityMatrix(legacyTimestamp, "legacy timestamp"),
    /not a valid Meta_Kim runtime capability matrix/u,
  );

  const missingModeClaim = structuredClone(canonicalMatrix);
  delete missingModeClaim.platforms[0].capabilities[0].claimsByMode.interactive_host;
  assert.throws(
    () => validateRuntimeCapabilityMatrix(missingModeClaim, "missing mode claim"),
    /invalid or duplicate capability/u,
  );

  const promotedLegacySummary = structuredClone(canonicalMatrix);
  const cursorChoice = promotedLegacySummary.platforms
    .find((entry) => entry.platform === "cursor").capabilities
    .find((entry) => entry.capability === "native choice surface");
  cursorChoice.support = "native";
  cursorChoice.confidence = "verified_docs";
  assert.throws(
    () => validateRuntimeCapabilityMatrix(promotedLegacySummary, "promoted summary"),
    /non-conservative legacy capability summary/u,
  );

  const malicious = JSON.parse(JSON.stringify(canonicalMatrix));
  malicious.platforms[0].capabilities[0]["__proto__"] = { polluted: true };
  const maliciousText = JSON.stringify(malicious).replace(
    '"platform":"claude_code"',
    '"__proto__":{"polluted":true},"platform":"claude_code"',
  );
  assert.throws(
    () => parseRuntimeCapabilityMatrix(maliciousText, "malicious matrix"),
    /unsafe object key/u,
  );
});

test("semantic MCP proof requires the complete top-level canonical matrix", () => {
  const response = structuredClone(canonicalMatrix);
  assert.equal(
    assertExactRuntimeCapabilityMatrix(response, canonicalMatrix),
    response,
  );
  response.knownConstraints = {
    ...response.knownConstraints,
    injected: ["top-level drift that a platforms-only comparison would miss"],
  };
  assert.throws(
    () => assertExactRuntimeCapabilityMatrix(response, canonicalMatrix),
    /does not exactly match/u,
  );
});
