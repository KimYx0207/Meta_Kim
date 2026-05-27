import path from "node:path";
import { promises as fs } from "node:fs";

export const CODEX_SKILL_DESCRIPTION_MAX_CHARS = 1024;

const BLOCK_SCALAR_TOKENS = new Set(["|", "|-", "|+", ">", ">-", ">+"]);

export function extractFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return null;
  }

  return match[1];
}

function unquoteScalar(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function stripBlockIndent(lines) {
  const nonEmptyIndents = lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^[ \t]*/)?.[0]?.length ?? 0);
  const indent = Math.min(...nonEmptyIndents, Infinity);
  if (!Number.isFinite(indent) || indent <= 0) {
    return lines;
  }
  return lines.map((line) => (line.trim() ? line.slice(indent) : ""));
}

function extractFrontmatterField(raw, fieldName) {
  const frontmatter = extractFrontmatter(raw);
  if (!frontmatter) {
    return null;
  }

  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[ \t]+/.test(line)) {
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_.-]+):(.*)$/);
    if (!match || match[1] !== fieldName) {
      continue;
    }

    const value = match[2].trim();
    if (!BLOCK_SCALAR_TOKENS.has(value)) {
      return unquoteScalar(value);
    }

    const blockLines = [];
    for (
      let blockIndex = index + 1;
      blockIndex < lines.length;
      blockIndex += 1
    ) {
      const blockLine = lines[blockIndex];
      if (blockLine.trim() && !/^[ \t]+/.test(blockLine)) {
        break;
      }
      blockLines.push(blockLine);
    }

    const stripped = stripBlockIndent(blockLines);
    const joined = value.startsWith(">")
      ? stripped.join(" ").replace(/[ \t]+/g, " ")
      : stripped.join("\n");
    return value.endsWith("-") ? joined.trimEnd() : joined;
  }

  return null;
}

export function getSkillDescriptionLength(raw) {
  const description = extractFrontmatterField(raw, "description");
  if (description == null) {
    return null;
  }
  return Array.from(description).length;
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

  const descriptionLength = getSkillDescriptionLength(raw);
  if (
    descriptionLength !== null &&
    descriptionLength > CODEX_SKILL_DESCRIPTION_MAX_CHARS
  ) {
    return {
      ok: false,
      code: "description_too_long",
      message:
        `description is ${descriptionLength} characters; Codex supports at most ` +
        `${CODEX_SKILL_DESCRIPTION_MAX_CHARS}`,
    };
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

export async function detectPluginBundleSkillResidue(targetDir) {
  if (!(await pathExists(targetDir))) {
    return false;
  }

  const markerNames = [
    ".claude-plugin",
    ".codex-plugin",
    ".cursor-plugin",
    "plugin.json",
    "marketplace.json",
  ];
  const runtimeAdapterNames = [
    ".agents",
    ".claude",
    ".codex",
    ".cursor",
    ".opencode",
    "openclaw",
  ];

  let hasMarker = false;
  for (const name of markerNames) {
    if (await pathExists(path.join(targetDir, name))) {
      hasMarker = true;
      break;
    }
  }
  if (!hasMarker) {
    return false;
  }

  let adapterCount = 0;
  for (const name of runtimeAdapterNames) {
    if (await pathExists(path.join(targetDir, name))) {
      adapterCount += 1;
    }
  }

  return adapterCount >= 2;
}

export async function detectManagedInstallConflict(
  targetDir,
  {
    skillId,
    subdirPath,
    manifestManagedPaths = [],
    legacyFlatMetaTheory = false,
  } = {},
) {
  if (!(await pathExists(targetDir))) {
    return { conflict: false };
  }

  const resolvedTarget = path.resolve(targetDir);
  for (const entry of manifestManagedPaths) {
    const entryPath = typeof entry === "string" ? entry : entry?.path;
    if (!entryPath || path.resolve(entryPath) !== resolvedTarget) {
      continue;
    }

    if (
      isTrustedManagedManifestEntry(entry, skillId) ||
      (await hasManagedInstallResidue(targetDir, subdirPath))
    ) {
      return { conflict: true, reason: "manifest_managed_path" };
    }
  }

  if (legacyFlatMetaTheory && path.basename(targetDir) === "meta-theory.md") {
    return { conflict: true, reason: "legacy_flat_meta_theory" };
  }

  if (await detectLegacySubdirInstall(targetDir, subdirPath)) {
    return { conflict: true, reason: "legacy_subdir_install" };
  }

  if (await detectPluginBundleSkillResidue(targetDir)) {
    return { conflict: true, reason: "plugin_bundle_residue" };
  }

  return { conflict: false };
}

function isTrustedManagedManifestEntry(entry, skillId) {
  if (!entry || typeof entry === "string") {
    return false;
  }

  if (skillId && entry.skillId === skillId) {
    return true;
  }

  const purpose = String(entry.purpose ?? "");
  if (skillId && purpose === `${skillId}-global-skill`) {
    return true;
  }

  const source = String(entry.source ?? "");
  return (
    entry.category === "A" &&
    entry.kind === "dir" &&
    /global-skill$/.test(purpose) &&
    /install-global-skills|sync-global-meta-theory|setup\.mjs/.test(source)
  );
}

async function hasManagedInstallResidue(targetDir, subdirPath) {
  return (
    (await detectLegacySubdirInstall(targetDir, subdirPath)) ||
    (await detectPluginBundleSkillResidue(targetDir))
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

/**
 * Monorepos such as CLI-Anything place a markdown-only SKILL.md under each pip package:
 * `{tool}/agent-harness/.../{tool}/skills/SKILL.md`. That file documents the CLI for agents
 * that read the installed package; it is not a Claude Code skill root and often omits YAML
 * frontmatter. Skipping quarantine preserves upstream layout without renaming to SKILL.invalid.md.
 *
 * Still subject to hook-path auto-fix when frontmatter is valid (rare for these files).
 */
export function shouldSkipHarnessPackageSkillDoc(relPath) {
  const n = relPath.replace(/\\/g, "/");
  return /\/agent-harness\/.+\/skills\/SKILL\.md$/i.test(n);
}

/**
 * Third-party plugins (everything-claude-code, superpowers, etc.) ship bundled
 * documentation SKILL.md files under `docs/{locale}/skills/` subtrees.
 * These are reference docs bundled inside the plugin repo — not installable skills —
 * and often lack valid YAML frontmatter. Skip quarantine so they stay in place.
 */
export function shouldSkipDocsSkillDoc(relPath) {
  const n = relPath.replace(/\\/g, "/");
  // docs/{locale}/skills/SKILL.md  OR  docs/{locale}/skills/{subdir}/SKILL.md
  return /docs\/[^/]+\/skills\/(.+\/)?SKILL\.md$/i.test(n);
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

/**
 * Known incorrect hook command paths in third-party skills, mapped to their correct paths.
 * Key = exact string fragment to find; Value = replacement string.
 *
 * HOW THIS WORKS:
 * When install-skill-sanitizer runs, it scans every installed skill's SKILL.md.
 * For each skill, if the frontmatter is valid YAML, it then checks the content for
 * known broken hook command strings. If found, the string is replaced in-place.
 * The file is only modified if dryRun=false.
 *
 * This is a curated list of known issues in Meta_Kim's dependency skills.
 * Add entries here when a dependency skill has a bug that would cause hook failures.
 * The fix is applied locally during install — it does NOT patch the upstream repo.
 * Set `silent: true` on a pattern to apply the fix without a yellow installer warning.
 */
const KNOWN_BROKEN_HOOK_PATTERNS = [];

/**
 * Returns a new string with all known broken hook patterns replaced,
 * plus an array of what was replaced.
 */
function applyHookPathFixes(rawContent) {
  let content = rawContent;
  const fixes = [];

  for (const pattern of KNOWN_BROKEN_HOOK_PATTERNS) {
    if (content.includes(pattern.find)) {
      content = content.replaceAll(pattern.find, pattern.replace);
      fixes.push({
        skill: pattern.skill,
        reason: pattern.reason,
        replaced: pattern.find,
        with: pattern.replace,
        silent: Boolean(pattern.silent),
      });
    }
  }

  return { content, fixes };
}

function buildDisabledSkillPath(filePath) {
  return path.join(path.dirname(filePath), "SKILL.invalid.md");
}

/**
 * Auto-quote top-level YAML frontmatter scalars whose unquoted value contains ": ",
 * which would otherwise break YAML parsing. Upstream skills (gstack, ecc) commonly
 * ship `description: Foo: bar` style values without quoting; this self-heal keeps
 * them installable without modifying upstream.
 * Returns {patched: string, applied: boolean}. Only top-level scalars are touched;
 * indented lines, list items, block scalars, and already-quoted values are left alone.
 */
function autoQuoteUnquotedColons(raw) {
  const fm = extractFrontmatter(raw);
  if (!fm) return { patched: raw, applied: false };

  const lines = fm.split(/\r?\n/);
  let changed = false;
  const patchedLines = lines.map((line) => {
    if (/^[ \t]/.test(line) || line.trim().startsWith("- ")) return line;
    const m = line.match(/^([A-Za-z0-9_.-]+):(\s*)(.*)$/);
    if (!m) return line;
    const [, key, gap, rawValue] = m;
    const value = rawValue.trim();
    if (!value) return line;
    if (BLOCK_SCALAR_TOKENS.has(value)) return line;
    if (
      value.startsWith('"') ||
      value.startsWith("'") ||
      value.startsWith("[") ||
      value.startsWith("{")
    )
      return line;
    if (!/: /.test(value)) return line;
    changed = true;
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `${key}:${gap || " "}"${escaped}"`;
  });

  if (!changed) return { patched: raw, applied: false };
  const patchedFm = patchedLines.join("\n");
  const patched = raw.replace(
    /^---\r?\n[\s\S]*?\r?\n---/,
    `---\n${patchedFm}\n---`,
  );
  return { patched, applied: true };
}

export async function sanitizeInstalledSkillTree(
  targetDir,
  { dryRun = false } = {},
) {
  const files = await listSkillFiles(targetDir);
  const invalidFiles = [];
  const hookPathFixes = [];

  for (const filePath of files) {
    const relToTarget = path.relative(targetDir, filePath).replace(/\\/g, "/");
    const skipHarnessInvalidOnly =
      shouldSkipHarnessPackageSkillDoc(relToTarget);

    const raw = await fs.readFile(filePath, "utf8");
    let effectiveRaw = raw;
    let validation = validateSkillFrontmatter(raw);
    let autoQuoteApplied = false;

    // Self-heal: upstream skills (gstack, ecc) ship unquoted descriptions with
    // colons; auto-quote them and re-validate before falling through to quarantine.
    if (!validation.ok && validation.code === "invalid_unquoted_colon") {
      const { patched, applied } = autoQuoteUnquotedColons(raw);
      if (applied) {
        const revalidation = validateSkillFrontmatter(patched);
        if (revalidation.ok) {
          effectiveRaw = patched;
          validation = revalidation;
          autoQuoteApplied = true;
        }
      }
    }

    if (validation.ok) {
      // Valid YAML: check for known broken hook command paths and patch in-place.
      const { content: patched, fixes } = applyHookPathFixes(effectiveRaw);
      const needsWrite = autoQuoteApplied || fixes.length > 0;
      if (fixes.length > 0) {
        hookPathFixes.push({
          filePath,
          fixes,
        });
      }
      if (needsWrite && !dryRun) {
        await fs.writeFile(filePath, patched, "utf8");
      }
      continue;
    }

    if (skipHarnessInvalidOnly || shouldSkipDocsSkillDoc(relToTarget)) {
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
    hookPathFixes,
    patchedFiles: hookPathFixes.length,
  };
}
