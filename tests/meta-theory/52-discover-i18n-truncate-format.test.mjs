import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const CANONICAL_INDEX_PATH = "config/capability-index/meta-kim-capabilities.json";
let canonicalIndexBefore;
let isolatedHome;

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function seedSkillFamilies() {
  const skillsRoot = path.join(isolatedHome, ".codex", "skills");
  const skillIds = [
    "vercel/one",
    "vercel/two",
    ...Array.from({ length: 25 }, (_, index) => `family-${String(index + 1).padStart(2, "0")}`),
  ];
  for (const skillId of skillIds) {
    const skillDir = path.join(skillsRoot, ...skillId.split("/"));
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), `# ${skillId}\n`, "utf8");
  }
}

function scan(langFlag = "--zh") {
  const args = [
    "scripts/discover-global-capabilities.mjs",
    "--runtime-inventory-only",
  ];
  if (langFlag) args.push(langFlag);
  const localAppData = path.join(isolatedHome, "AppData", "Local");
  mkdirSync(localAppData, { recursive: true });
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      LOCALAPPDATA: localAppData,
      APPDATA: path.join(isolatedHome, "AppData", "Roaming"),
      META_KIM_PROFILE: "discover-i18n-test",
    },
  });
  if (result.status !== 0 && result.status !== null) {
    if (result.stderr && result.stderr.trim()) {
      throw new Error(`script failed: ${result.stderr}`);
    }
  }
  return result.stdout;
}

describe("52 — Discover capabilities i18n truncate format", () => {
  before(() => {
    canonicalIndexBefore = readFileSync(CANONICAL_INDEX_PATH);
    isolatedHome = mkdtempSync(path.join(tmpdir(), "meta-kim-discover-i18n-"));
    seedSkillFamilies();
  });

  after(() => {
    try {
      const canonicalIndexAfter = readFileSync(CANONICAL_INDEX_PATH);
      assert.deepEqual(
        canonicalIndexAfter,
        canonicalIndexBefore,
        "runtime-only i18n scans must not change canonical index bytes",
      );
      assert.equal(
        sha256(canonicalIndexAfter),
        sha256(canonicalIndexBefore),
        "runtime-only i18n scans must not change the canonical index hash",
      );
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  test("zh output uses 剩余 N 项因篇幅关系未显示 wording", () => {
    const out = scan();
    assert.match(out, /剩余 \d+ 项因篇幅关系未显示/, "zh output must use 因篇幅关系未显示 wording");
  });

  test("zh output shows at least 10 family names before truncation", () => {
    const out = scan();
    // Match the Skills-by-family line (contains "vercel" or similar short family tokens), not the by-platform total line
    const familyLine = out.split("\n").find((l) => /\bvercel\s+\d+/.test(l));
    assert.ok(familyLine, "expected a Skills family line containing 'vercel N'");
    const body = familyLine.split(/\s*等\s*|,\s*more/)[0];
    const familyNames = body.split(/,\s*/).filter((s) => /\s\d+$/.test(s));
    assert.ok(familyNames.length >= 10, `expected >=10 visible families, got ${familyNames.length}`);
  });

  test("zh output does not use old 项未显示 wording", () => {
    const out = scan();
    assert.doesNotMatch(out, /项未显示/, "old 项未显示 wording should be replaced");
  });

  test("OUTPUT_I18N covers all 4 supported languages (en, zh, ja-JP, ko-KR)", () => {
    const src = readFileSync("scripts/discover-global-capabilities.mjs", "utf8");
    for (const lang of ["en:", "zh:", '"ja-JP":', '"ko-KR":']) {
      assert.ok(src.includes(lang), `OUTPUT_I18N must include ${lang} block`);
    }
  });

  test("normalizeOutputLang maps ja and ko prefixes to the new ja-JP / ko-KR blocks", () => {
    const src = readFileSync("scripts/discover-global-capabilities.mjs", "utf8");
    assert.ok(
      src.includes('startsWith("ja")) return "ja-JP"'),
      'must map ja → ja-JP (e.g. `if (raw.startsWith("ja")) return "ja-JP"`)'
    );
    assert.ok(
      src.includes('startsWith("ko")) return "ko-KR"'),
      'must map ko → ko-KR (e.g. `if (raw.startsWith("ko")) return "ko-KR"`)'
    );
  });
});
