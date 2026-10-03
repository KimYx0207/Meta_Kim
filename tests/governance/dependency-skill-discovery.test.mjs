import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverDependencySkillContracts } from "../../scripts/dependency-skill-discovery.mjs";

const project = {
  id: "tool-library", source: { localPath: null },
  interface: { capabilityIndex: { format: "component-capabilities-v1", path: "generated/capabilities.json", rootEnv: "TEST_TOOL_LIBRARY_ROOT" } },
};
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const json = (value) => JSON.stringify(stable(value), null, 2) + "\n";
const sha = (value) => createHash("sha256").update(value).digest("hex");
function fixture(t, { adapterMetadata = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meta-kim-skill-discovery-"));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const index = { schemaVersion: 1, components: [], capabilities: [] };
  const contracts = new Map();
  for (const [id, capabilityId, summary, triggers] of [
    ["offline-check", "local-source-inspection", "Offline local security scan", ["Scan local source for security vulnerability patterns"]],
    ["calendar-preview", "calendar-preview", "Calendar schedule preview", ["Preview next week calendar schedule"]],
  ]) {
    const capability = {
      id: capabilityId, summary, useWhen: triggers, doNotUseWhen: ["Do not install packages or use network services."],
      input: { type: "object", required: ["target"], properties: { target: { type: "string" } } },
      output: { type: "object", required: ["completed"], properties: { completed: { type: "boolean" } } },
      permissions: ["Read selected target", "Execute existing local tool"], sideEffects: [],
      humanGate: { required: false, when: [] }, validation: ["tests/behavior.py"],
      ...(adapterMetadata ? { futureExecution: { entrypoint: "scripts/scan.py", transport: "unknown-future-protocol", extra: { retained: true } } } : {}),
    };
    const installer = { ...capability, id: `${id}-install`, summary: "Apply selected projection installation", useWhen: ["Install selected projection"], permissions: ["Write selected installation"], sideEffects: ["Replace projection"], humanGate: { required: true, when: ["Before applying changes"] } };
    const contract = { schemaVersion: 1, id, componentType: "skill", componentVersion: "1.0.0", entrypoint: "SKILL.md", capabilities: [capability, installer], ...(adapterMetadata ? { futureComponentMetadata: { anything: "retained without validation or invocation" } } : {}) };
    contracts.set(id, contract);
    const files = {
      "SKILL.md": `---\nname: ${id}\n---\n# ${summary}\n`,
      "capability.json": json(contract),
      "tests/behavior.py": "raise RuntimeError('discovery must not execute validation')\n",
      ...(adapterMetadata ? { "scripts/scan.py": "raise RuntimeError('discovery must not execute adapter')\n" } : {}),
    };
    const componentPath = `skills/${id}`;
    const hash = createHash("sha256");
    for (const name of Object.keys(files).sort()) {
      const file = path.join(root, componentPath, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, files[name]);
      hash.update(name).update("\0").update(files[name]).update("\0");
    }
    const contentSha256 = hash.digest("hex"), contractSha256 = sha(json(contract));
    index.components.push({ id, componentType: "skill", componentVersion: "1.0.0", path: componentPath, entrypoint: "SKILL.md", capabilityIds: contract.capabilities.map((entry) => entry.id), validation: capability.validation, contentSha256, contractSha256 });
    for (const source of contract.capabilities) {
      const { futureExecution, ...projected } = source;
      index.capabilities.push({ ...projected, componentId: id, componentType: "skill", componentVersion: "1.0.0", componentPath, entrypoint: "SKILL.md", componentContentSha256: contentSha256, contractSha256 });
    }
  }
  index.componentCount = index.components.length; index.capabilityCount = index.capabilities.length;
  fs.mkdirSync(path.join(root, "generated"));
  const save = () => fs.writeFileSync(path.join(root, "generated/capabilities.json"), json(index));
  save();
  return { root, index, contracts, save, options: { projects: [project], projectRoot: root, environment: { TEST_TOOL_LIBRARY_ROOT: root }, capabilityNeedIds: ["local-source-inspection"] } };
}

test("a v1 selected skill is verified without importing installation permissions or invoking code", async (t) => {
  const { options, root } = fixture(t);
  fs.rmSync(path.join(root, "skills/calendar-preview"), { recursive: true });
  const result = await discoverDependencySkillContracts(options);
  assert.equal(result.sources[0].status, "verified_local");
  assert.deepEqual(result.sources[0].componentReadIds, ["offline-check"]);
  assert.equal(result.skills.length, 1);
  assert.equal(result.capabilities.length, 1);
  assert.equal(result.capabilities[0].componentVersion, "1.0.0");
  assert.equal(result.capabilities[0].indexPath, path.join(root, "generated/capabilities.json"));
  assert.equal(result.capabilities[0].indexSha256, sha(fs.readFileSync(result.capabilities[0].indexPath)));
  assert.equal(result.skills[0].indexSha256, result.capabilities[0].indexSha256);
  assert.deepEqual(result.capabilities[0].permissions, ["Read selected target", "Execute existing local tool"]);
  assert.deepEqual(result.capabilities[0].sideEffects, []);
  assert.equal(result.capabilities[0].humanGate.required, false);
  assert.equal(result.skills[0].fullContract.capabilities.length, 2);
  for (const record of [result, result.skills[0], result.capabilities[0]]) {
    assert.equal(record.canExecute, false); assert.equal(record.invocationStatus, "not_invoked");
  }
  assert.equal(result.capabilities[0].evidence.liveVerification, false);
});

test("hashed full contract retains unknown adapter metadata deliberately omitted by a v1 index", async (t) => {
  const { options, contracts } = fixture(t, { adapterMetadata: true });
  const result = await discoverDependencySkillContracts(options);
  assert.deepEqual(result.skills[0].fullContract, contracts.get("offline-check"));
  assert.deepEqual(result.capabilities[0].selectedCapability.futureExecution, contracts.get("offline-check").capabilities[0].futureExecution);
  assert.equal(result.capabilities[0].canExecute, false);
  assert.equal(result.capabilities[0].invocationStatus, "not_invoked");
});

test("generic request matching uses index evidence and reads only the chosen component", async (t) => {
  const { options, root } = fixture(t);
  fs.rmSync(path.join(root, "skills/calendar-preview"), { recursive: true });
  const result = await discoverDependencySkillContracts({ ...options, capabilityNeedIds: [], request: "Scan local source for security vulnerability patterns" });
  assert.equal(result.matches[0].selected, "tool-library:local-source-inspection");
  assert.deepEqual(result.sources[0].componentReadIds, ["offline-check"]);
  assert.equal(result.skills.length, 1);
});

test("nonspecific and unmatched needs do not open component contracts or SKILL text", async (t) => {
  const { options, root } = fixture(t);
  fs.rmSync(path.join(root, "skills"), { recursive: true });
  for (const controls of [{ capabilityNeedIds: [], request: "帮我处理一些事情" }, { capabilityNeedIds: ["unavailable-capability"] }, { capabilityNeedIds: [], request: "" }]) {
    const result = await discoverDependencySkillContracts({ ...options, ...controls });
    assert.deepEqual(result.skills, []);
    assert.ok(result.sources.every((source) => source.componentReadIds.length === 0));
    assert.ok(result.matches.every((match) => match.status === "no_match"));
  }
});

test("ambiguous request or capability id is not resolved by reading competing full contracts", async (t) => {
  const { options, root } = fixture(t);
  fs.rmSync(path.join(root, "skills"), { recursive: true });
  const projects = [project, { ...project, id: "other-library" }];
  for (const controls of [{ capabilityNeedIds: ["local-source-inspection"] }, { capabilityNeedIds: [], request: "Scan local source for security vulnerability patterns" }]) {
    const result = await discoverDependencySkillContracts({ ...options, ...controls, projects });
    assert.equal(result.matches[0].status, "ambiguous");
    assert.deepEqual(result.skills, []);
    assert.ok(result.sources.every((source) => source.componentReadIds.length === 0));
  }
});

test("qualified need ids disambiguate explicit libraries and multiple needs deduplicate component reads", async (t) => {
  const { options } = fixture(t);
  const result = await discoverDependencySkillContracts({ ...options, projects: [project, { ...project, id: "other-library" }], capabilityNeedIds: ["tool-library:local-source-inspection", "tool-library:offline-check-install", "tool-library:local-source-inspection"] });
  assert.equal(result.capabilities.length, 2);
  assert.equal(result.skills.length, 1);
  assert.deepEqual(result.sources[0].componentReadIds, ["offline-check"]);
  assert.deepEqual(result.sources[1].componentReadIds, []);
  assert.deepEqual(result.capabilities.find((entry) => entry.id.endsWith(":offline-check-install")).permissions, ["Write selected installation"]);
});

test("unsupported indexed types never trigger a full skill read", async (t) => {
  const { options, index, save, root } = fixture(t);
  index.capabilities[0].componentType = "tool"; save();
  fs.rmSync(path.join(root, "skills"), { recursive: true });
  const result = await discoverDependencySkillContracts(options);
  assert.equal(result.matches[0].status, "unsupported_type");
  assert.deepEqual(result.sources[0].componentReadIds, []);
});

test("content and full contract metadata drift fail closed", async (t) => {
  for (const name of ["SKILL.md", "capability.json"]) {
    const { options, root } = fixture(t, { adapterMetadata: true });
    const file = path.join(root, "skills/offline-check", name);
    if (name === "SKILL.md") fs.appendFileSync(file, "changed prompt\n");
    else {
      const contract = JSON.parse(fs.readFileSync(file, "utf8"));
      contract.capabilities[0].futureExecution.entrypoint = "scripts/changed.py";
      fs.writeFileSync(file, json(contract));
    }
    const result = await discoverDependencySkillContracts(options);
    assert.deepEqual(result.skills, []);
    assert.equal(result.matches[0].status, "invalid_contract");
    assert.match(result.sources[0].reason, /hash mismatch/);
  }
});

test("index permission or projection drift cannot grant a capability different from its source", async (t) => {
  const { options, index, save } = fixture(t);
  index.capabilities[0].permissions.push("Write all source files"); save();
  const result = await discoverDependencySkillContracts(options);
  assert.deepEqual(result.capabilities, []);
  assert.match(result.sources[0].reason, /differs from source contract: permissions/);
});

test("linked roots and selected component trees are rejected without fallback", async (t) => {
  const { root, options } = fixture(t);
  const alias = path.join(root, "linked-library");
  fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  const rootResult = await discoverDependencySkillContracts({ ...options, environment: { TEST_TOOL_LIBRARY_ROOT: alias } });
  assert.equal(rootResult.sources[0].status, "invalid");
  assert.match(rootResult.sources[0].reason, /symlink or junction/);
  assert.equal(path.dirname(path.resolve(alias)), path.resolve(root));
  assert.equal(path.basename(alias), 'linked-library');
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  fs.rmSync(alias, { recursive: true });
  assert.equal(fs.existsSync(path.join(root, 'skills/offline-check/capability.json')), true);
  const component = path.join(root, "skills/offline-check"), moved = path.join(root, "moved-component");
  fs.renameSync(component, moved);
  fs.symlinkSync(moved, component, process.platform === "win32" ? "junction" : "dir");
  const componentResult = await discoverDependencySkillContracts(options);
  assert.deepEqual(componentResult.capabilities, []);
  assert.match(componentResult.sources[0].reason, /symlink or junction/);
});

test("missing explicit roots override valid local copies and absent roots do not scan siblings", async (t) => {
  const { root, options } = fixture(t);
  const result = await discoverDependencySkillContracts({ ...options, localOverrides: { dependencyRoots: { "tool-library": root } }, environment: { TEST_TOOL_LIBRARY_ROOT: path.join(root, "missing") } });
  assert.equal(result.sources[0].status, "missing");
  assert.deepEqual(result.capabilities, []);
  const absent = await discoverDependencySkillContracts({ ...options, environment: {} });
  assert.equal(absent.sources[0].status, "not_configured");
});

test("pre-resolved absolute declarations remain bound when the caller changes to an isolated project root", async (t) => {
  const { root, options } = fixture(t);
  const isolated = path.join(root, "isolated-worktree"); fs.mkdirSync(isolated);
  const result = await discoverDependencySkillContracts({ ...options, projectRoot: isolated, environment: {}, localOverrides: { dependencyRoots: { "tool-library": root } } });
  assert.equal(result.sources[0].status, "verified_local");
  assert.equal(result.skills[0].componentRoot, path.join(root, "skills/offline-check"));
});

test("reference-only declarations and malformed index schemas stay outside contract selection", async (t) => {
  const { options, index, save } = fixture(t);
  const reference = await discoverDependencySkillContracts({ ...options, projects: [{ ...project, interface: { ...project.interface, invokeAs: "reference" } }] });
  assert.equal(reference.sources[0].status, "reference_only");
  assert.deepEqual(reference.capabilities, []);
  index.schemaVersion = 2; save();
  const unsupported = await discoverDependencySkillContracts(options);
  assert.equal(unsupported.sources[0].status, "invalid");
  assert.match(unsupported.sources[0].reason, /unsupported.*schema/);
});

test("malformed index trigger metadata is a recorded gap before matching or component reads", async (t) => {
  const { options, index, save, root } = fixture(t);
  index.capabilities[0].useWhen = "not an array"; save();
  fs.rmSync(path.join(root, "skills"), { recursive: true });
  const result = await discoverDependencySkillContracts({ ...options, capabilityNeedIds: [], request: "security scan" });
  assert.equal(result.sources[0].status, "invalid");
  assert.match(result.sources[0].reason, /useWhen.*string array/);
  assert.deepEqual(result.sources[0].componentReadIds, []);
  assert.deepEqual(result.capabilities, []);
});
