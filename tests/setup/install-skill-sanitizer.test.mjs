import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import {
  CODEX_SKILL_DESCRIPTION_MAX_CHARS,
  detectLegacySubdirInstall,
  getSkillDescriptionLength,
  sanitizeInstalledSkillTree,
  shouldSkipBundledRuntimePath,
  shouldSkipDocsSkillDoc,
  shouldSkipHarnessPackageSkillDoc,
  validateSkillFrontmatter,
} from "../../scripts/install-skill-sanitizer.mjs";

const tempDirs = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-sanitize-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("skill frontmatter validation", () => {
  test("accepts quoted descriptions with colon-space", () => {
    const raw = `---
name: laravel-verification
description: "Verification loop for Laravel projects: env checks and deploy readiness"
---

# Heading
`;

    assert.deepEqual(validateSkillFrontmatter(raw), {
      ok: true,
      code: "ok",
      message: "frontmatter valid",
    });
  });

  test("accepts block scalar descriptions", () => {
    const raw = `---
name: cli-anything-adguardhome
description: >-
  Command-line interface for AdGuard Home: manage DNS and filtering.
---
`;

    assert.equal(validateSkillFrontmatter(raw).ok, true);
  });

  test("reports folded block description length for Codex compatibility", () => {
    const raw = `---
name: meta-theory
description: >-
  First line
  second line
---
`;

    assert.equal(getSkillDescriptionLength(raw), "First line second line".length);
  });

  test("rejects descriptions longer than the Codex skill limit", () => {
    const raw = `---
name: too-long
description: "${"x".repeat(CODEX_SKILL_DESCRIPTION_MAX_CHARS + 1)}"
---
`;

    const result = validateSkillFrontmatter(raw);
    assert.equal(result.ok, false);
    assert.equal(result.code, "description_too_long");
  });

  test("rejects missing frontmatter", () => {
    const raw = "# Exa CLI Skill";
    const result = validateSkillFrontmatter(raw);
    assert.equal(result.ok, false);
    assert.equal(result.code, "missing_frontmatter");
  });

  test("rejects unquoted colon-space in scalar values", () => {
    const raw = `---
name: laravel-verification
description: Verification loop for Laravel projects: env checks and deploy readiness
---
`;

    const result = validateSkillFrontmatter(raw);
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_unquoted_colon");
  });
});

describe("legacy subdir detection", () => {
  test("detects full-repo leftovers under a subdir-managed target", async () => {
    const root = await makeTempDir();
    const targetDir = path.join(root, "everything-claude-code");
    await fs.mkdir(path.join(targetDir, "skills"), { recursive: true });
    await fs.mkdir(path.join(targetDir, ".git"), { recursive: true });

    assert.equal(await detectLegacySubdirInstall(targetDir, "skills"), true);
  });

  test("does not flag nested subdir content without git metadata", async () => {
    const root = await makeTempDir();
    const targetDir = path.join(root, "everything-claude-code");
    await fs.mkdir(path.join(targetDir, "skills"), { recursive: true });

    assert.equal(await detectLegacySubdirInstall(targetDir, "skills"), false);
  });

  test("does not flag a clean extracted subdir install", async () => {
    const root = await makeTempDir();
    const targetDir = path.join(root, "everything-claude-code");
    await fs.mkdir(path.join(targetDir, "laravel-verification"), {
      recursive: true,
    });

    assert.equal(await detectLegacySubdirInstall(targetDir, "skills"), false);
  });
});

describe("bundled runtime path skip", () => {
  test("skips OpenClaw/Codex/Cursor subtrees case-insensitively", () => {
    assert.equal(shouldSkipBundledRuntimePath("openclaw"), true);
    assert.equal(shouldSkipBundledRuntimePath("OpenClaw/skills/foo"), true);
    assert.equal(
      shouldSkipBundledRuntimePath("gstack/openclaw/skills/x"),
      true,
    );
    assert.equal(shouldSkipBundledRuntimePath("pkg/Cursor/extra"), true);
    assert.equal(shouldSkipBundledRuntimePath("legit-skill"), false);
    assert.equal(shouldSkipBundledRuntimePath("openclawish"), false);
  });
});

describe("harness package skill doc skip (CLI-Anything-style monorepos)", () => {
  test("matches .../agent-harness/.../skills/SKILL.md only", () => {
    assert.equal(
      shouldSkipHarnessPackageSkillDoc(
        "exa/agent-harness/cli_anything/exa/skills/SKILL.md",
      ),
      true,
    );
    assert.equal(
      shouldSkipHarnessPackageSkillDoc(
        "Exa/Agent-Harness/cli_anything/exa/skills/skill.md",
      ),
      true,
    );
    assert.equal(
      shouldSkipHarnessPackageSkillDoc("exa/skills/SKILL.md"),
      false,
    );
    assert.equal(
      shouldSkipHarnessPackageSkillDoc("agent-harness/readme/SKILL.md"),
      false,
    );
  });
});

describe("docs skill doc skip (everything-claude-code-style bundled docs)", () => {
  test("skips docs/{locale}/skills/SKILL.md case-insensitively", () => {
    assert.equal(
      shouldSkipDocsSkillDoc(
        "docs/zh-TW/skills/project-guidelines-example/SKILL.md",
      ),
      true,
    );
    assert.equal(
      shouldSkipDocsSkillDoc("docs/zh-TW/skills/verification-loop/SKILL.md"),
      true,
    );
    assert.equal(shouldSkipDocsSkillDoc("docs/en/skills/foo/SKILL.md"), true);
    assert.equal(shouldSkipDocsSkillDoc("docs/zh-CN/skills/SKILL.md"), true);
    assert.equal(
      shouldSkipDocsSkillDoc(
        "everything-claude-code/docs/zh-TW/skills/demo/SKILL.md",
      ),
      true,
    );
    assert.equal(
      shouldSkipDocsSkillDoc("docs/zh-TW/some-other/SKILL.md"),
      false,
    );
    assert.equal(
      shouldSkipDocsSkillDoc("docs/zh-TW/skills/SKILL.invalid.md"),
      false,
    );
    assert.equal(
      shouldSkipDocsSkillDoc("superpowers/docs/zh-TW/skills/x/SKILL.md"),
      true,
    );
  });

  test("does not quarantine bundled docs SKILL.md inside managed installs", async () => {
    const root = await makeTempDir();
    const pluginRoot = path.join(root, "everything-claude-code");
    const docsSkillDir = path.join(
      pluginRoot,
      "docs",
      "zh-TW",
      "skills",
      "project-guidelines-example",
    );
    await fs.mkdir(docsSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(docsSkillDir, "SKILL.md"),
      "# no yaml frontmatter\n",
      "utf8",
    );

    const result = await sanitizeInstalledSkillTree(pluginRoot);
    assert.equal(result.scanned, 1);
    assert.equal(result.quarantined, 0);
    assert.equal(
      await fs
        .access(path.join(docsSkillDir, "SKILL.md"))
        .then(() => true)
        .catch(() => false),
      true,
    );
  });
});

describe("skill tree sanitization", () => {
  test("does not quarantine SKILL.md under bundled openclaw/ trees (e.g. gstack)", async () => {
    const root = await makeTempDir();
    const nested = path.join(
      root,
      "gstack",
      "openclaw",
      "skills",
      "gstack-openclaw-ceo-review",
    );
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(
      path.join(nested, "SKILL.md"),
      "# no yaml frontmatter — would be invalid at repo root\n",
      "utf8",
    );

    const result = await sanitizeInstalledSkillTree(path.join(root, "gstack"));
    assert.equal(result.scanned, 0);
    assert.equal(result.quarantined, 0);
    assert.equal(
      await fs
        .access(path.join(nested, "SKILL.md"))
        .then(() => true)
        .catch(() => false),
      true,
    );
  });

  test("quarantines only invalid SKILL.md files and preserves sibling content", async () => {
    const root = await makeTempDir();
    const invalidSkillDir = path.join(root, "exa", "skills");
    const validSkillDir = path.join(root, "adguardhome", "skills");
    await fs.mkdir(invalidSkillDir, { recursive: true });
    await fs.mkdir(validSkillDir, { recursive: true });

    await fs.writeFile(
      path.join(invalidSkillDir, "SKILL.md"),
      "# Exa CLI Skill\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(invalidSkillDir, "README.md"),
      "keep me",
      "utf8",
    );
    await fs.writeFile(
      path.join(validSkillDir, "SKILL.md"),
      `---
name: cli-anything-adguardhome
description: "Valid skill: DNS automation"
---
`,
      "utf8",
    );

    const result = await sanitizeInstalledSkillTree(root);

    assert.equal(result.scanned, 2);
    assert.equal(result.quarantined, 1);
    assert.equal(
      await fs
        .access(path.join(invalidSkillDir, "SKILL.md"))
        .then(() => true)
        .catch(() => false),
      false,
    );
    assert.equal(
      await fs
        .access(path.join(invalidSkillDir, "SKILL.invalid.md"))
        .then(() => true)
        .catch(() => false),
      true,
    );
    assert.equal(
      await fs.readFile(path.join(invalidSkillDir, "README.md"), "utf8"),
      "keep me",
    );
    assert.equal(
      await fs
        .access(path.join(validSkillDir, "SKILL.md"))
        .then(() => true)
        .catch(() => false),
      true,
    );
  });

  test("does not quarantine markdown-only SKILL.md under agent-harness package paths", async () => {
    const root = await makeTempDir();
    const managed = path.join(root, "cli-anything");
    const pkgSkill = path.join(
      managed,
      "exa",
      "agent-harness",
      "cli_anything",
      "exa",
      "skills",
    );
    await fs.mkdir(pkgSkill, { recursive: true });
    await fs.writeFile(
      path.join(pkgSkill, "SKILL.md"),
      "# Exa CLI Skill\n\nNo YAML frontmatter.\n",
      "utf8",
    );

    const result = await sanitizeInstalledSkillTree(managed);
    assert.equal(result.scanned, 1);
    assert.equal(result.quarantined, 0);
    assert.equal(
      await fs.readFile(path.join(pkgSkill, "SKILL.md"), "utf8"),
      "# Exa CLI Skill\n\nNo YAML frontmatter.\n",
    );
    assert.equal(
      await fs
        .access(path.join(pkgSkill, "SKILL.invalid.md"))
        .then(() => true)
        .catch(() => false),
      false,
    );
  });

  test("does not touch unrelated sibling skill directories", async () => {
    const root = await makeTempDir();
    const managedTarget = path.join(root, "cli-anything");
    const userTarget = path.join(root, "my-custom-skill");
    const managedInvalidDir = path.join(managedTarget, "exa", "skills");
    const userInvalidDir = path.join(userTarget, "notes");

    await fs.mkdir(managedInvalidDir, { recursive: true });
    await fs.mkdir(userInvalidDir, { recursive: true });

    await fs.writeFile(
      path.join(managedInvalidDir, "SKILL.md"),
      "# missing frontmatter\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(userInvalidDir, "SKILL.md"),
      "# also missing frontmatter\n",
      "utf8",
    );

    const result = await sanitizeInstalledSkillTree(managedTarget);

    assert.equal(result.quarantined, 1);
    assert.equal(
      await fs
        .access(path.join(managedInvalidDir, "SKILL.invalid.md"))
        .then(() => true)
        .catch(() => false),
      true,
    );
    assert.equal(
      await fs
        .access(path.join(userInvalidDir, "SKILL.md"))
        .then(() => true)
        .catch(() => false),
      true,
    );
    assert.equal(
      await fs
        .access(path.join(userInvalidDir, "SKILL.invalid.md"))
        .then(() => true)
        .catch(() => false),
      false,
    );
  });
});
