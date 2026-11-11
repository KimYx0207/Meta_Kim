import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverOptionalEngines, optionalEngineCommand, qualifyOptionalEngineInterfaces } from "../../src/infrastructure/capabilities/optional-engine-discovery.mjs";
import { buildGlobalCapabilityInventory } from "../../scripts/discover-global-capabilities.mjs";
import { searchCapabilities } from "../../scripts/search-capabilities.mjs";

const registry = JSON.parse(readFileSync(new URL("../../config/capability-index/dependency-project-registry.json", import.meta.url)));

test("native desktop MCP records its version condition without granting execution from documentation or PATH", async (t) => {
  const { bin } = fixture(t);
  const file = path.join(bin, "agent-desktop");
  writeFileSync(file, "#!/bin/sh\nexit 99\n"); chmodSync(file, 0o755);
  const project = registry.projects.find(entry => entry.id === "agent-desktop");
  const mcp = project.interfaces.find(entry => entry.type === "mcp");
  assert.deepEqual([mcp.transport, mcp.command, mcp.args], ["stdio", "agent-desktop", ["mcp"]]);
  assert.equal(mcp.versionRequirement.minimum, "1.2.0");
  for (const [version, expected] of [[null, "unverified"], ["1.1.9", "incompatible"], ["1.2.0", "compatible"], ["1.3.0", "compatible"], ["1.2.0-beta", "unverified"]]) {
    const result = qualifyOptionalEngineInterfaces([mcp], version)[0];
    assert.equal(result.versionStatus, expected);
    assert.equal(result.hostVerified, false); assert.equal(result.routeEligible, false);
  }
  const [record] = await discoverOptionalEngines({ projects: [project], environment: { PATH: bin }, platform: "linux" });
  assert.equal(record.available, true); assert.equal(record.version, null);
  assert.equal(record.interfaceQualification.find(entry => entry.type === "mcp").versionStatus, "unverified");
  assert.equal(record.liveVerified, false); assert.equal(record.routeEligible, false);
  const command = optionalEngineCommand(record, "codex", "Codex");
  assert.equal(command.executionBlock, true);
  assert.deepEqual(command.metadata.interfaceQualification, record.interfaceQualification);
});
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-engine-presence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"); mkdirSync(bin);
  return { root, bin };
}

test("engine discovery observes files without executing a CLI, installing anything or granting live authority", async (t) => {
  const { root, bin } = fixture(t); const sentinel = path.join(root, "executed");
  const file = path.join(bin, "agent-browser");
  writeFileSync(file, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(sentinel)},'should never run');\n`);
  chmodSync(file, 0o755);
  const records = await discoverOptionalEngines({ projects: registry.projects, environment: { PATH: bin }, platform: "linux" });
  const browser = records.find((entry) => entry.id === "agent-browser");
  assert.equal(browser.availability, "executable_present");
  assert.equal(browser.capabilityType, "browser_automation");
  assert.deepEqual(browser.interfaces.map((entry) => entry.type), ["cli", "mcp", "skill"]);
  assert.equal(browser.interfaces.find((entry) => entry.type === "mcp").transport, "stdio");
  assert.equal(records.find((entry) => entry.id === "agent-desktop").availability, "not_located_on_allowed_path");
  for (const entry of records) {
    assert.equal(entry.liveVerified, false); assert.equal(entry.routeEligible, false);
    assert.equal(entry.version, null); assert.equal(entry.permissionStatus, "unknown");
    assert.equal(entry.invocationState, "not_invoked");
  }
  assert.equal(existsSync(sentinel), false);
});

test("a Windows npm shim is observable while relative PATH entries and injected command names are rejected", async (t) => {
  const { bin } = fixture(t); writeFileSync(path.join(bin, "agent-desktop.CMD"), "@exit /b 91\n");
  const records = await discoverOptionalEngines({ projects: registry.projects, platform: "win32", environment: { PATH: `.;relative;${bin}`, PATHEXT: ".EXE;.CMD" } });
  assert.equal(records.find((entry) => entry.id === "agent-desktop").available, true);
  const unsafe = structuredClone(registry.projects.find((entry) => entry.id === "agent-browser"));
  unsafe.interface.executableDiscovery.command = "agent-browser; touch unexpected";
  await assert.rejects(discoverOptionalEngines({ projects: [unsafe], environment: { PATH: bin } }), /Invalid read-only/u);
});

test("the existing inventory and search preserve capability/interface distinction without promoting presence into execution", async (t) => {
  const { root, bin } = fixture(t); const file = path.join(bin, "agent-browser");
  writeFileSync(file, "fixture executable, never invoked\n"); chmodSync(file, 0o755);
  const [engine] = await discoverOptionalEngines({ projects: registry.projects.filter((entry) => entry.id === "agent-browser"), environment: { PATH: bin }, platform: "linux" });
  const inventory = await buildGlobalCapabilityInventory([{ platformId: "codex", platform: "Codex", capabilities: { commands: [optionalEngineCommand(engine, "codex", "Codex")] } }], "default", null, { ownershipIndex: new Map() });
  const record = inventory.byCapabilityType.commands["codex:agent-browser-cli"];
  assert.equal(record.routeEligible, false);
  assert.equal(record.metadata.observationKind, "path_presence_only");
  const inventoryPath = path.join(root, "inventory.json"); writeFileSync(inventoryPath, JSON.stringify(inventory));
  const found = await searchCapabilities({ query: "browser automation", runtime: "codex", inventoryPath, canonicalPath: path.join(root, "no-canonical.json"), homeDir: root });
  assert.equal(found.status, "candidates");
  assert.equal(found.candidates[0].capabilityType, "browser_automation");
  assert.equal(found.candidates[0].interfaces.find((entry) => entry.type === "mcp").transport, "stdio");
  assert.equal(found.candidates[0].routeEligible, false);
  assert.equal(found.candidates[0].invocationState, "not_invoked");
});
