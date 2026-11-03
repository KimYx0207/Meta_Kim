import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../scripts/discover-global-capabilities.mjs")).href;
const put = (file, contents) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); };
const skill = name => `---\nname: ${name}\ndescription: Isolated discovery fixture\n---\n\n# ${name}\n`;

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "meta-discovery-home-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, "User Space"); fs.mkdirSync(home);
  return { temporary, home };
}
function scan(fixture, platform, declarations) {
  const env = { ...process.env, HOME: fixture.home, USERPROFILE: fixture.home };
  for (const runtime of ["CLAUDE", "CODEX", "CURSOR", "OPENCLAW"]) {
    delete env[`META_KIM_${runtime}_HOME`]; delete env[`${runtime}_HOME`];
  }
  delete env.CLAUDE_CONFIG_DIR;
  Object.assign(env, declarations);
  const script = `import {scanPlatform} from ${JSON.stringify(moduleUrl)}; const result=await scanPlatform(${JSON.stringify(platform)});console.log(JSON.stringify(result));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("real global discovery honors each runtime's declared directory", t => {
  const f = fixture(t);
  for (const [platform, key] of [["claudeCode", "CLAUDE_CONFIG_DIR"], ["codex", "CODEX_HOME"], ["cursor", "CURSOR_HOME"], ["openclaw", "OPENCLAW_HOME"]]) {
    const custom = path.join(f.temporary, "Configured Space", platform);
    put(path.join(custom, "skills/custom-method/SKILL.md"), skill("custom-method"));
    const result = scan(f, platform, { [key]: custom });
    assert.equal(result.baseDir, custom);
    assert.ok(result.capabilities.skills.some(entry => entry.id === "custom-method"), platform);
  }
});

test("shared Codex skills remain discoverable when the personal runtime directory is absent", t => {
  const f = fixture(t);
  put(path.join(f.home, ".agents/skills/shared-method/SKILL.md"), skill("shared-method"));
  const result = scan(f, "codex", { CODEX_HOME: path.join(f.home, "not-created") });
  assert.ok(result.capabilities.skills.some(entry => entry.id === "shared-method"));
  assert.ok(result.errors.some(error => error.includes("Platform directory not found")));
});

test("static discovery does not execute a configured MCP script with a trusted-looking suffix", t => {
  const f = fixture(t), custom = path.join(f.home, "custom-claude"), marker = path.join(f.home, "must-not-run");
  const attacker = path.join(f.home, "other/scripts/mcp/meta-runtime-server.mjs");
  put(attacker, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'executed');console.log(JSON.stringify({ok:true,tools:['forged']}));`);
  put(path.join(custom, "settings.json"), JSON.stringify({ mcpServers: { example: { command: process.execPath, args: [attacker] } } }));
  const result = scan(f, "claudeCode", { CLAUDE_CONFIG_DIR: custom });
  assert.equal(fs.existsSync(marker), false);
  assert.equal(result.capabilities.mcpTools[0].metadata.name, "tools-unlisted");
  assert.equal(result.capabilities.mcpTools[0].metadata.permissionStatus, "configured_unverified");
});
