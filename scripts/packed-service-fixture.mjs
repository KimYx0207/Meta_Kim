import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256, stableJson } from "../src/infrastructure/capabilities/source-integrity.mjs";

/** A synthetic local dependency for installation tests, never a reviewed release. */
export function writePackedServiceFixture(localDependencyRoot) {
  const root = path.join(localDependencyRoot, "Kim_Service");
  const relative = "skills/find-skill";
  const contract = {
    schemaVersion: 1, id: "find-skill", componentType: "skill", componentVersion: "0.0.0",
    entrypoint: "SKILL.md", capabilities: [],
  };
  const files = {
    "SKILL.md": "---\nname: find-skill\ndescription: Synthetic local packed installation fixture; not a production method.\n---\n\n# Find skill fixture\n\nUsed only to verify dependency installation. No host invocation or external capability is claimed.\n",
    "capability.json": stableJson(contract),
  };
  const hash = createHash("sha256");
  mkdirSync(path.join(root, relative), { recursive: true });
  for (const name of Object.keys(files).sort()) {
    writeFileSync(path.join(root, relative, name), files[name], "utf8");
    hash.update(name).update("\0").update(files[name]).update("\0");
  }
  const component = {
    id: contract.id, componentType: contract.componentType, componentVersion: contract.componentVersion,
    entrypoint: contract.entrypoint, path: relative, capabilityIds: [], validation: [],
    contentSha256: hash.digest("hex"), contractSha256: sha256(stableJson(contract)),
  };
  mkdirSync(path.join(root, "generated"), { recursive: true });
  writeFileSync(path.join(root, "generated/capabilities.json"), stableJson({
    schemaVersion: 1, componentCount: 1, capabilityCount: 0, components: [component], capabilities: [],
  }), "utf8");
  return root;
}
