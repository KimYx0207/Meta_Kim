import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareOpenClawLocal } from "../../scripts/prepare-openclaw-local.mjs";

function agentDir(homeDir, agentId) {
  return path.join(homeDir, ".openclaw", "agents", agentId, "agent");
}

test("current OpenClaw SQLite auth storage remains runtime-managed", async () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-openclaw-sqlite-"));
  try {
    const mainDir = agentDir(homeDir, "main");
    mkdirSync(mainDir, { recursive: true });
    writeFileSync(path.join(mainDir, "openclaw-agent.sqlite"), "sqlite-store");
    const messages = [];

    const result = await prepareOpenClawLocal({
      homeDir,
      agentIds: ["meta-artisan", "meta-warden"],
      log: (message) => messages.push(message),
    });

    assert.equal(result.storageMode, "sqlite_runtime_managed");
    assert.deepEqual(result.changedTargets, []);
    assert.match(messages.join("\n"), /without copying credential databases/u);
    for (const agentId of ["meta-artisan", "meta-warden"]) {
      const targetDir = agentDir(homeDir, agentId);
      assert.equal(existsSync(path.join(targetDir, "openclaw-agent.sqlite")), false);
      assert.equal(existsSync(path.join(targetDir, "auth.json")), false);
      assert.equal(existsSync(path.join(targetDir, "auth-profiles.json")), false);
    }
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("legacy OpenClaw auth files retain the existing compatibility mirror", async () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-openclaw-legacy-"));
  try {
    const mainDir = agentDir(homeDir, "main");
    mkdirSync(mainDir, { recursive: true });
    const fixtures = {
      "auth.json": "legacy-auth",
      "auth-profiles.json": "legacy-profiles",
      "models.json": "legacy-models",
    };
    for (const [fileName, value] of Object.entries(fixtures)) {
      writeFileSync(path.join(mainDir, fileName), value);
    }

    const result = await prepareOpenClawLocal({
      homeDir,
      agentIds: ["meta-artisan"],
      log: () => {},
    });

    assert.equal(result.storageMode, "legacy_file_mirror");
    assert.equal(result.changedTargets.length, 3);
    for (const [fileName, value] of Object.entries(fixtures)) {
      assert.equal(
        readFileSync(path.join(agentDir(homeDir, "meta-artisan"), fileName), "utf8"),
        value,
      );
    }
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
