import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-installer-log-"));

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

test("installer --log-file writes diagnostics without crashing", () => {
  const runtimeHome = path.join(tempRoot, "codex");
  const logFile = path.join(tempRoot, "installer.log");
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "scripts", "install-global-skills-all-runtimes.mjs"),
      "--dry-run",
      "--targets",
      "codex",
      "--skills=",
      "--skip-plugins",
      "--skip-inventory-refresh",
      "--log-file",
      logFile,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        META_KIM_CODEX_HOME: runtimeHome,
        CODEX_HOME: runtimeHome,
        META_KIM_SKIP_OPTIONAL_TOOLS: "1",
      },
      timeout: 30_000,
      windowsHide: true,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(logFile), true);
  assert.match(readFileSync(logFile, "utf8"), /codex|Codex/u);
});
