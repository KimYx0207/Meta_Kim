import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assertPortablePackedReferences,
  collectNonPortablePackedReferences,
} from "../../scripts/verify-packed-user-install-update.mjs";

const MAINTAINER_PATH_PATTERNS = [
  /\b[A-Za-z]:[/\\]KimProject(?:[/\\]|$)/iu,
  /\b[A-Za-z]:[/\\]Users[/\\]Kim(?:[/\\]|$)/iu,
];

function collectMaintainerPaths(value, location = "$") {
  if (typeof value === "string") {
    return MAINTAINER_PATH_PATTERNS.some((pattern) => pattern.test(value))
      ? [{ location, value }]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectMaintainerPaths(entry, `${location}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      collectMaintainerPaths(entry, `${location}.${key}`),
    );
  }
  return [];
}

test("governance scripts and registries do not hardcode personal Kim_Decision path", () => {
  for (const file of [
    "scripts/discover-dependency-capabilities.mjs",
    "config/capability-index/dependency-project-registry.json",
    "config/capability-index/weapon-registry.json",
    "config/governance/decision-pattern-catalog.json",
  ]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /D:[/\\]KimProject[/\\]Kim_Decision/i, file);
  }
});

test("packed portability checks recognize cross-host Windows drive and UNC roots", () => {
  for (const [root, reference] of [
    ["D:/work/source-repository", "D:/work/source-repository/scripts/entry.mjs"],
    ["D:\\work\\source-repository", "d:\\WORK\\SOURCE-REPOSITORY\\scripts\\entry.mjs"],
    ["D:/work/cache/../source-repository/", "D:/work/source-repository/bin/entry.mjs"],
    ["\\\\server\\share\\source-repository", "\\\\SERVER\\share\\source-repository\\bin\\entry.mjs"],
    ["//server/share/source-repository/", "//server/share/source-repository/bin/entry.mjs"],
    [path.resolve("test-source-root"), `${path.resolve("test-source-root")}/scripts/entry.mjs`],
  ]) {
    assert.throws(
      () => assertPortablePackedReferences({ command: `node "${reference}"` }, { forbiddenRoots: [root] }),
      /non-portable references/u,
      `${root} must be recognized on ${process.platform}`,
    );
  }
});

test("dependency registry contains no maintainer drive paths", () => {
  const registry = JSON.parse(
    readFileSync("config/capability-index/dependency-project-registry.json", "utf8"),
  );
  assert.deepEqual(
    collectMaintainerPaths(registry),
    [],
    "use repository URI/revision evidence instead of a maintainer workspace path",
  );
  assert.deepEqual(
    collectMaintainerPaths({ examples: ["C:/path/to/project", "D:/Project/example"] }),
    [],
    "generic Windows path examples are documentation, not maintainer path leakage",
  );
});

test("packed generated runtime fragments reject source homes, deleted pack roots, and placeholders", () => {
  const sourceRoot = "D:/work/source-repository";
  const maintainerHome = "C:/Users/Maintainer";
  const deletedPackRoot = "E:/temp/npm-pack/extract/package";
  const forbiddenRoots = [sourceRoot, maintainerHome, deletedPackRoot];
  const valid = {
    command: "meta-kim",
    args: ["mcp", "serve"],
    runtimeWrapper: "C:/Users/RuntimeUser/.claude/hooks/meta-kim/launcher.mjs",
  };
  assert.deepEqual(
    assertPortablePackedReferences(valid, { forbiddenRoots }),
    { status: "passed", findingCount: 0 },
  );

  const findings = collectNonPortablePackedReferences(
    {
      source: `${sourceRoot}/scripts/mcp/meta-runtime-server.mjs`,
      legacyHome: `${maintainerHome}/old-install`,
      deletedPack: `${deletedPackRoot}/bin/meta-kim.mjs`,
      placeholder: "__REPO_ROOT__/scripts/mcp/meta-runtime-server.mjs",
    },
    { forbiddenRoots },
  );
  assert.deepEqual(
    new Set(findings.map((finding) => finding.reason)),
    new Set(["forbidden_machine_root", "unresolved_placeholder"]),
  );
  assert.throws(
    () => assertPortablePackedReferences({ command: "REPLACE_WITH_REPO_ROOT/bin" }),
    /non-portable references/u,
  );
});
