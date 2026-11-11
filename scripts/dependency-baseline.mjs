import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Release compatibility data, not evidence of installation or live execution. */
export function readDependencyBaseline(file = new URL("../config/dependency-baseline.json", import.meta.url)) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(data.schemaVersion, 1, "Unsupported dependency baseline");
  assert.match(data.kimService?.repository ?? "", /^[A-Za-z0-9_.-]+\/Kim_Service$/u, "Invalid Service repository baseline");
  assert.match(data.kimService?.commit ?? "", /^[a-f0-9]{40}$/u, "Service baseline must be a full commit");
  assert.equal(data.graphify?.package, "graphifyy", "Unexpected Graphify package");
  assert.match(data.graphify?.version ?? "", /^\d+\.\d+\.\d+$/u, "Graphify baseline must be an exact version");
  for (const key of ["nodeRegression", "nodeDshHost"]) {
    assert.equal(typeof data.npm?.[key], "string", `Node ${key} baseline must be an exact version`);
    assert.match(data.npm[key], /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u,
      `Node ${key} baseline must be an exact version`);
  }
  return data;
}

export const DEPENDENCY_BASELINE = readDependencyBaseline();

// A file argument is unnecessary: GitHub supplies an absolute output path in
// the environment, so this command is identical in Bash and PowerShell jobs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.deepEqual(process.argv.slice(2), ["--github-output"], "Usage: node scripts/dependency-baseline.mjs --github-output");
  assert.ok(process.env.GITHUB_OUTPUT?.trim(), "GITHUB_OUTPUT is required");
  appendFileSync(process.env.GITHUB_OUTPUT, [
    `service-commit=${DEPENDENCY_BASELINE.kimService.commit}`,
    `service-repository=${DEPENDENCY_BASELINE.kimService.repository}`,
    `node-regression=${DEPENDENCY_BASELINE.npm.nodeRegression}`,
    `node-dsh-host=${DEPENDENCY_BASELINE.npm.nodeDshHost}`,
    "",
  ].join("\n"), "utf8");
}
