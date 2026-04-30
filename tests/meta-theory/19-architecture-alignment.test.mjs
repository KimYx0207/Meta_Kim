import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const THIS_FILE = normalizePath(path.relative(REPO_ROOT, fileURLToPath(import.meta.url)));
const DOC_GAP_MARKER = "[DOC GAP]";
const CANONICAL_CAPABILITY_INDEX =
  "config/capability-index/meta-kim-capabilities.json";

function normalizePath(value) {
  return value.replace(/\\/g, "/");
}

async function readText(relativePath) {
  return fs.readFile(path.join(REPO_ROOT, relativePath), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

async function walkFiles(relativeDir, predicate = () => true) {
  const root = path.join(REPO_ROOT, relativeDir);
  const results = [];

  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const relativePath = normalizePath(path.relative(REPO_ROOT, fullPath));
        if (predicate(relativePath)) results.push(relativePath);
      }
    }
  }

  await walk(root);
  return results.sort();
}

function hasFailureNearLine(lines, index) {
  const nearby = lines.slice(Math.max(0, index - 3), index + 4).join("\n");
  return /assert\.(fail|throws|rejects)|throw new Error/.test(nearby);
}

describe("architecture alignment contracts", () => {
  test("DOC GAP warnings either fail tests or appear in the known-gap allowlist", async () => {
    const allowlist = await readJson("tests/fixtures/known-doc-gaps.json");
    const testFiles = await walkFiles(
      "tests",
      (file) => file.endsWith(".mjs") && file !== THIS_FILE,
    );
    const docGaps = [];

    for (const file of testFiles) {
      const lines = (await readText(file)).split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!line.includes(DOC_GAP_MARKER)) return;
        docGaps.push({
          path: file,
          line: index + 1,
          text: line.trim(),
          failsTest: hasFailureNearLine(lines, index),
        });
      });
    }

    const unresolved = docGaps.filter((gap) => {
      if (gap.failsTest) return false;
      return !allowlist.some(
        (entry) =>
          entry.path === gap.path &&
          gap.text.includes(entry.messageContains) &&
          entry.owner &&
          entry.expiry &&
          entry.closeCondition,
      );
    });

    assert.deepEqual(
      unresolved,
      [],
      "DOC GAP warnings must fail the test or be explicitly tracked in tests/fixtures/known-doc-gaps.json",
    );

    const staleAllowlistEntries = allowlist.filter(
      (entry) =>
        !docGaps.some(
          (gap) =>
            gap.path === entry.path && gap.text.includes(entry.messageContains),
        ),
    );

    assert.deepEqual(
      staleAllowlistEntries,
      [],
      "known DOC GAP allowlist entries must point at an active warning",
    );
  });

  test("meta:verify:all includes graphify contract checking", async () => {
    const pkg = await readJson("package.json");
    const verifyAll = pkg.scripts?.["meta:verify:all"] ?? "";

    assert.match(
      verifyAll,
      /npm run meta:graphify:check/,
      "meta:verify:all must include npm run meta:graphify:check",
    );
  });

  test("docs do not describe Claude runtime mirrors as canonical sources", async () => {
    const docs = await walkFiles("docs", (file) => file.endsWith(".md"));
    const forbiddenLines = [];
    const mirrorPattern = /`?\.claude\/(?:capability-index|agents|skills)\b/i;
    const canonicalSourcePattern =
      /\bcanonical\b|\bsource of truth\b|\bprimary source\b|主源|总源|思想基础/iu;

    for (const file of docs) {
      const lines = (await readText(file)).split(/\r?\n/);
      lines.forEach((line, index) => {
        if (mirrorPattern.test(line) && canonicalSourcePattern.test(line)) {
          forbiddenLines.push(`${file}:${index + 1}:${line.trim()}`);
        }
      });
    }

    assert.deepEqual(
      forbiddenLines,
      [],
      "docs must describe .claude capability index, agents, and skills as runtime mirrors, not canonical sources",
    );
  });

  test("docs do not use docs/meta.md as the Meta-Theory source", async () => {
    const docs = await walkFiles("docs", (file) => file.endsWith(".md"));
    const forbiddenLines = [];
    const theorySourcePattern =
      /theory.*source|source.*theory|理论.*(主源|总源)|元理论.*(主源|总源|思想基础)|思想基础/iu;

    for (const file of docs) {
      const lines = (await readText(file)).split(/\r?\n/);
      lines.forEach((line, index) => {
        if (line.includes("docs/meta.md") && theorySourcePattern.test(line)) {
          forbiddenLines.push(`${file}:${index + 1}:${line.trim()}`);
        }
      });
    }

    assert.deepEqual(
      forbiddenLines,
      [],
      "docs must point Meta-Theory source language at canonical/skills/meta-theory, not docs/meta.md",
    );
  });

  test("capability mirror indexes identify the config capability index as canonical", async () => {
    const mirrors = [
      ".claude/capability-index/meta-kim-capabilities.json",
      ".codex/capability-index/meta-kim-capabilities.json",
      ".cursor/capability-index/meta-kim-capabilities.json",
      "openclaw/capability-index/meta-kim-capabilities.json",
    ];

    const mismatches = [];
    for (const mirror of mirrors) {
      const index = await readJson(mirror);
      if (index.canonicalProjection !== CANONICAL_CAPABILITY_INDEX) {
        mismatches.push({
          mirror,
          canonicalProjection: index.canonicalProjection,
        });
      }
    }

    assert.deepEqual(
      mismatches,
      [],
      `capability mirrors must identify ${CANONICAL_CAPABILITY_INDEX} as canonicalProjection`,
    );
  });
});
