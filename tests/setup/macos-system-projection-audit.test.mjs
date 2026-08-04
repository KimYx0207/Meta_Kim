import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { auditMacosSystemLevelProjections } from "../../scripts/macos-system-projection-audit.mjs";

function fixtureHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), "meta-kim-macos-projection-"));
  mkdirSync(path.join(home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(path.join(home, ".meta-kim"), { recursive: true });
  return home;
}

function writeLaunchAgent(home, name) {
  writeFileSync(path.join(home, "Library", "LaunchAgents", name), "<plist/>\n");
}

function writeStartScript(home, body) {
  writeFileSync(path.join(home, ".meta-kim", "mcp-memory-start.sh"), body);
}

async function audit(home, platform = "darwin") {
  const { findings } = await auditMacosSystemLevelProjections({ homeRoot: home, platform });
  return {
    findings,
    kinds: findings.map((finding) => finding.kind),
    notices: findings.filter((finding) => finding.severity === "notice"),
    text: findings.map((finding) => finding.message).join("\n"),
  };
}

test("macOS system-level projection audit", async (t) => {
  await t.test("reports nothing when nothing was projected", async () => {
    const { findings } = await audit(fixtureHome());
    assert.deepEqual(findings, []);
  });

  await t.test("stays silent off darwin", async () => {
    const home = fixtureHome();
    writeLaunchAgent(home, "com.meta-kim.legacy-service.plist");
    writeStartScript(home, "#!/bin/sh\nosascript -e 'display dialog \"boom\"'\n");
    const { findings } = await audit(home, "linux");
    assert.deepEqual(findings, []);
  });

  await t.test("every finding is advisory — the audit has no failure verdict", async () => {
    // The contract the caller depends on: this pass never gates the check.
    // Ownership of these files is not recorded anywhere, so a hard failure
    // would red-flag installs that have no repair command to run.
    const home = fixtureHome();
    writeLaunchAgent(home, "com.meta-kim.legacy-service.plist");
    writeStartScript(home, "#!/bin/sh\nosascript -e 'display dialog \"boom\"'\n");
    const result = await audit(home);
    assert.equal(result.notices.length, 2);
    for (const finding of result.findings) {
      assert.ok(["info", "notice"].includes(finding.severity), finding.severity);
    }
    assert.ok(!("ready" in result.findings), "audit must not expose a pass/fail verdict");
  });

  await t.test("flags a LaunchAgent no current code path generates", async () => {
    const home = fixtureHome();
    writeLaunchAgent(home, "com.meta-kim.legacy-service.plist");
    const result = await audit(home);
    assert.deepEqual(result.kinds, ["launch-agent-unrecognized"]);
    // Wording must not assert ownership the audit cannot establish.
    assert.match(result.text, /review before removing/u);
    assert.doesNotMatch(result.text, /orphan/iu);
  });

  await t.test("accepts a label the current generator still writes", async () => {
    const home = fixtureHome();
    writeLaunchAgent(home, "com.meta-kim.mcp-memory-service.plist");
    const result = await audit(home);
    assert.deepEqual(result.kinds, ["launch-agent"]);
    assert.equal(result.notices.length, 0);
  });

  await t.test("describes non-.plist suffixes as inert, not as user intent", async () => {
    const home = fixtureHome();
    writeLaunchAgent(home, "com.meta-kim.mcp-memory-service.plist.disabled");
    writeLaunchAgent(home, "com.meta-kim.legacy-service.plist.bak");
    const result = await audit(home);
    assert.deepEqual(result.kinds, ["launch-agent-inert", "launch-agent-inert"]);
    assert.equal(result.notices.length, 0);
    // `.bak` means launchd will not load it. It does not mean the user
    // deliberately disabled anything, so the audit must not claim that.
    assert.doesNotMatch(result.text, /disabled by the user/u);
  });

  await t.test("flags a start script that raises a GUI dialog, case-insensitively", async () => {
    for (const body of [
      "#!/bin/sh\nosascript -e 'display dialog \"boom\"'\n",
      "#!/bin/sh\nOSASCRIPT -e 'display dialog \"boom\"'\n",
    ]) {
      const home = fixtureHome();
      writeStartScript(home, body);
      const result = await audit(home);
      assert.deepEqual(result.kinds, ["start-script-raises-dialog"], body);
      assert.match(result.text, /likely predates this release/u);
    }
  });

  await t.test("accepts a start script that reports through the log file", async () => {
    const home = fixtureHome();
    writeStartScript(home, '#!/bin/sh\nprintf "%s\\n" "$MSG" >>"$LOG_PATH"\n');
    const result = await audit(home);
    assert.deepEqual(result.kinds, ["start-script"]);
    assert.equal(result.notices.length, 0);
  });

  await t.test("reports unreadable state instead of silently passing", async () => {
    // An unreadable directory is not the same as an empty one. Swallowing the
    // error would report a clean system the audit never actually saw.
    const home = fixtureHome();
    const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
    chmodSync(launchAgentsDir, 0o000);
    try {
      const result = await audit(home);
      assert.deepEqual(result.kinds, ["launch-agents-unreadable"]);
      assert.match(result.text, /state is unknown/u);
    } finally {
      chmodSync(launchAgentsDir, 0o755);
    }
  });
});
