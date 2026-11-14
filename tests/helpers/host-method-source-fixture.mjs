import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { stableJson } from "../../scripts/dependency-agent-discovery.mjs";

/** Local source contracts for transport tests only. Nothing invokes a model,
 * authenticates a user choice or claims the author's professional quality. */
export function createHostMethodSourceFixture(root) {
  const sha = value => createHash("sha256").update(value).digest("hex");
  const components = [], capabilities = [];
  for (const [id, type, inputField] of [["package-analyst", "agent", "facts"], ["source-check", "skill", "target"], ["unselected", "skill", "target"]]) {
    const entrypoint = type === "agent" ? "AGENT.md" : "SKILL.md";
    const capability = { id: `${id}-deliver`, summary: `Read package metadata with ${id}`, useWhen: ["Read package metadata and check source evidence"], doNotUseWhen: ["Never publish or invent evidence"],
      input: { type: "object", additionalProperties: false, required: [inputField], properties: { [inputField]: { type: "string" } } },
      output: { type: "object", required: ["report"], properties: { report: { type: "string" } } },
      permissions: ["filesystem:read-user-materials"], sideEffects: [], humanGate: { required: false, when: [] }, validation: ["tests/contract.test.mjs"] };
    const contract = { schemaVersion: 1, id, componentType: type, componentVersion: "0.1.0", entrypoint, capabilities: [capability] };
    const method = { schemaVersion: 1, roleId: id, protocol: "host-bound-task-method-v1", steps: [`METHOD_STEP:${id}:compare current source`], acceptance: ["Actual values match source"],
      knowledgeAssets: [{ id: `${id}-knowledge`, path: "references/guide.md", appliesTo: ["always"], sourceRefs: ["fixture:source-guide"] },
        { id: `${id}-optional`, path: "references/optional.md", appliesTo: ["read only when explicitly selected"], sourceRefs: ["fixture:optional-guide"] }] };
    const files = { [entrypoint]: `---\nname: ${id}\ndescription: Read package metadata\n${type === "agent" ? "tools: Read\n" : ""}---\nSOURCE_METHOD:${id}\n`,
      "capability.json": stableJson(contract), "method.json": stableJson(method), "references/guide.md": `KNOWLEDGE:${id}:retain the exact source value`,
      "references/optional.md": `OPTIONAL_KNOWLEDGE:${id}`, "tests/contract.test.mjs": "throw new Error('Source discovery must never execute validation');\n" };
    const componentPath = `${type}s/${id}`;
    const hash = createHash("sha256");
    for (const file of Object.keys(files).sort()) {
      const target = path.join(root, componentPath, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, files[file]);
      hash.update(file).update("\0").update(files[file]).update("\0");
    }
    const contentSha256 = hash.digest("hex"), contractSha256 = sha(stableJson(contract));
    components.push({ id, componentType: type, componentVersion: "0.1.0", path: componentPath, entrypoint, capabilityIds: [capability.id], validation: capability.validation, contentSha256, contractSha256 });
    capabilities.push({ ...capability, componentId: id, componentType: type, componentVersion: "0.1.0", componentPath, entrypoint, componentContentSha256: contentSha256, contractSha256 });
  }
  mkdirSync(path.join(root, "generated"), { recursive: true });
  writeFileSync(path.join(root, "generated/capabilities.json"), stableJson({ schemaVersion: 1, components, capabilities, componentCount: components.length, capabilityCount: capabilities.length }));
  return { root };
}
