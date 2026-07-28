import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    assert.equal(payload.tools.length, 6);
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
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-mcp-required-"));
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

test("packaged resource reader uses one handle with before/after stability checks", () => {
  const source = readFileSync("scripts/mcp/runtime-resource-contract.mjs", "utf8");
  assert.match(source, /const before = await handle\.stat\(\)/u);
  assert.match(source, /const text = await handle\.readFile\("utf8"\)/u);
  assert.match(source, /const after = await handle\.stat\(\)/u);
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
