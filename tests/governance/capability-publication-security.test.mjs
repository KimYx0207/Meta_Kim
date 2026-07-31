import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  loadCapabilityOwnershipIndex,
  parseSimpleYaml,
} from "../../scripts/discover-global-capabilities.mjs";
import {
  createEmpty,
  record,
  writeManifest,
} from "../../scripts/install-manifest.mjs";
import { sanitizeCapabilityPublicationText } from "../../scripts/capability-publication-sanitizer.mjs";

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function manifestWithFile(scope, manifestRoot, target) {
  return record(createEmpty({ scope, repoRoot: manifestRoot, metaKimVersion: "test" }), {
    path: target,
    category: "A",
    kind: "file",
    purpose: "test",
    ownershipClass: "install_projection",
  });
}

test("block-scalar skill descriptions remain valid metadata", () => {
  const metadata = parseSimpleYaml([
    "name: meta-theory",
    "description: >-",
    "  First line of the description.",
    "  Second line with: punctuation.",
    "license: MIT",
  ].join("\n"));
  assert.equal(metadata.name, "meta-theory");
  assert.equal(
    metadata.description,
    "First line of the description. Second line with: punctuation.",
  );
  assert.equal(metadata.license, "MIT");
  const literal = parseSimpleYaml([
    "name: literal",
    "description: |2+",
    "  First literal line.",
    "  Second literal line.",
  ].join("\n"));
  assert.equal(literal.description, "First literal line.\nSecond literal line.");
});

test("published capability text redacts credentials and non-home absolute paths", () => {
  const leaked = [
    "Authorization: Bearer private-token-value",
    "API_KEY=private-api-key-value",
    "OPENAI_API_KEY=openai-secret-value",
    "AWS_SECRET_ACCESS_KEY=aws-secret-value",
    "GH_TOKEN=gh-secret-value",
    "https://user:password@example.test/path?access_token=secret-value",
    "D:\\External\\Private\\owner.toml",
    "\\\\server\\private\\owner.toml",
    '"D:\\External Project\\Private\\owner.toml"',
    "/opt/private project/owner.toml",
    '"/opt/quoted private/owner.toml"',
    "/opt/comma,path/owner.toml; trailing diagnostic text",
  ].join("\n");
  const sanitized = sanitizeCapabilityPublicationText(leaked, {
    repoRoot: "D:\\Repo",
    homeDir: "C:\\Users\\Kim",
  });
  for (const secret of [
    "private-token-value",
    "private-api-key-value",
    "openai-secret-value",
    "aws-secret-value",
    "gh-secret-value",
    "user:password",
    "secret-value",
    "D:\\External",
    "\\\\server\\private",
    "External Project",
    "/opt/private project",
    "/opt/quoted private",
    "/opt/comma,path",
  ]) {
    assert.equal(sanitized.includes(secret), false, secret);
  }
  assert.match(sanitized, /REDACTED_SECRET/u);
  assert.match(sanitized, /REDACTED_(?:ABSOLUTE|UNC)_PATH/u);
  assert.match(sanitized, /REDACTED_POSIX_PATH/u);
});

test("install ownership enforces manifest scope/root and preserves sedimented project copies", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-ownership-security-"));
  const globalRoot = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const outsideRoot = path.join(root, "outside");
  const manifestDir = path.join(root, "manifests");
  const globalFile = path.join(globalRoot, ".codex", "agents", "valid.toml");
  const protectedFile = path.join(projectRoot, ".codex", "agents", "protected.toml");
  const outsideFile = path.join(outsideRoot, "escaped.toml");
  const validGlobalManifest = path.join(manifestDir, "global.json");
  const wrongScopeManifest = path.join(manifestDir, "wrong-scope.json");
  const projectManifest = path.join(manifestDir, "project.json");
  await fs.mkdir(path.dirname(globalFile), { recursive: true });
  await fs.mkdir(path.dirname(protectedFile), { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(globalFile, "valid", "utf8");
  await fs.writeFile(protectedFile, "protected", "utf8");
  await fs.writeFile(outsideFile, "outside", "utf8");
  try {
    writeManifest(
      validGlobalManifest,
      manifestWithFile("global", globalRoot, globalFile),
    );
    writeManifest(
      wrongScopeManifest,
      manifestWithFile("project", projectRoot, globalFile),
    );
    let project = manifestWithFile("project", projectRoot, protectedFile);
    project = record(project, {
      path: outsideFile,
      category: "A",
      kind: "file",
      purpose: "escaped",
      ownershipClass: "install_projection",
    });
    writeManifest(projectManifest, project);

    const protectedProjectPaths = {
      absolutePaths: new Set([pathKey(protectedFile)]),
      absoluteRoots: new Set(),
      relativePaths: new Set(),
      relativeRoots: new Set(),
    };
    const ownership = await loadCapabilityOwnershipIndex({
      projectRoot,
      globalRoot,
      protectedProjectPaths,
      manifestSpecs: [
        { scope: "global", file: validGlobalManifest, root: globalRoot },
        { scope: "global", file: wrongScopeManifest, root: globalRoot },
        { scope: "project", file: projectManifest, root: projectRoot },
      ],
    });
    assert.equal(ownership.get(pathKey(globalFile))?.owner, "meta_kim");
    assert.equal(ownership.get(pathKey(protectedFile))?.owner, "project");
    assert.equal(
      ownership.get(pathKey(protectedFile))?.ownershipClass,
      "runtime_sedimented_project_copy",
    );
    assert.equal(ownership.has(pathKey(outsideFile)), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
