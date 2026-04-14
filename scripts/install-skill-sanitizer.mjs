import path from "node:path";
import { promises as fs } from "node:fs";

const BLOCK_SCALAR_TOKENS = new Set(["|", "|-", "|+", ">", ">-", ">+"]);

export function extractFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return null;
  }

  return match[1];
}

export function validateSkillFrontmatter(raw) {
  const frontmatter = extractFrontmatter(raw);
  if (!frontmatter) {
    return {
      ok: false,
      code: "missing_frontmatter",
      message: "missing YAML frontmatter delimited by ---",
    };
  }

  const lines = frontmatter.split(/\r?\n/);
  let expectsIndentedBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const isIndented = /^[ \t]+/.test(line);
    if (expectsIndentedBlock) {
      if (isIndented) {
        continue;
      }
      expectsIndentedBlock = false;
    }

    if (isIndented || trimmed.startsWith("- ")) {
      continue;
    }

    const keyValueMatch = line.match(/^([A-Za-z0-9_.-]+):(.*)$/);
    if (!keyValueMatch) {
      return {
        ok: false,
        code: "invalid_line",
        message: `invalid YAML frontmatter line: ${line}`,
      };
    }

    const value = keyValueMatch[2].trim();
    if (!value) {
      continue;
    }

    if (BLOCK_SCALAR_TOKENS.has(value)) {
      expectsIndentedBlock = true;
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")) ||
      value.startsWith("[") ||
      value.startsWith("{")
    ) {
      continue;
    }

    if (/: /.test(value)) {
      return {
        ok: false,
        code: "invalid_unquoted_colon",
        message:
          "invalid YAML: unquoted scalar contains ': ' and will break frontmatter parsing",
      };
    }
  }

  return { ok: true, code: "ok", message: "frontmatter valid" };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function detectLegacySubdirInstall(targetDir, subdirPath) {
  if (!subdirPath) {
    return false;
  }

  const nestedSubdir = path.join(
    targetDir,
    ...subdirPath.split("/").filter(Boolean),
  );
  const gitMetadataPath = path.join(targetDir, ".git");
  // Only treat nested subdir installs as legacy when the target still looks
  // like a full cloned repository. This avoids deleting arbitrary user-created
  // folders that happen to contain a matching subdir name.
  return (
    (await pathExists(nestedSubdir)) && (await pathExists(gitMetadataPath))
  );
}

/**
 * Bundled copies of other runtimes (OpenClaw/Codex/Cursor) ship nested SKILL.md files
 * that are not required to match Claude Code frontmatter. Match case-insensitively and
 * skip any path segment (e.g. OpenClaw vs openclaw on Windows).
 */
export function shouldSkipBundledRuntimePath(relPath) {
  const n = relPath.replace(/\\/g, "/");
  return (
    /(^|\/)openclaw(\/|$)/i.test(n) ||
    /(^|\/)codex(\/|$)/i.test(n) ||
    /(^|\/)cursor(\/|$)/i.test(n)
  );
}

export async function listSkillFiles(rootDir) {
  const results = [];

  async function walk(currentDir, relPath = "") {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const childRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (shouldSkipBundledRuntimePath(childRelPath)) {
          continue;
        }
        await walk(path.join(currentDir, entry.name), childRelPath);
        continue;
      }

      if (entry.isFile() && entry.name === "SKILL.md") {
        results.push(path.join(currentDir, entry.name));
      }
    }
  }

  if (await pathExists(rootDir)) {
    await walk(rootDir);
  }

  return results;
}

function buildDisabledSkillPath(filePath) {
  return path.join(path.dirname(filePath), "SKILL.invalid.md");
}

export async function sanitizeInstalledSkillTree(
  targetDir,
  { dryRun = false } = {},
) {
  const files = await listSkillFiles(targetDir);
  const invalidFiles = [];

  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8");
    const validation = validateSkillFrontmatter(raw);
    if (validation.ok) {
      continue;
    }

    const disabledPath = buildDisabledSkillPath(filePath);
    invalidFiles.push({
      filePath,
      disabledPath,
      code: validation.code,
      message: validation.message,
    });

    if (dryRun) {
      continue;
    }

    await fs.rm(disabledPath, { force: true });
    await fs.rename(filePath, disabledPath);
  }

  return {
    scanned: files.length,
    quarantined: invalidFiles.length,
    invalidFiles,
  };
}
