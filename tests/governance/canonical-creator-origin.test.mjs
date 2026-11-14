import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { copyProjectCapability } from "../../scripts/project-capability-copy.mjs";
import { buildProjectCustomizationPacket, executeProjectCustomizationPacket } from "../../scripts/run-meta-theory-governed-execution.mjs";

test("every canonical creator artifact binds the actual indexed method, including explicit creation without professional requirements", t => {
  const framework = fileURLToPath(new URL("../..", import.meta.url));
  const index = JSON.parse(readFileSync(path.join(framework, "config/capability-index/meta-kim-capabilities.json"), "utf8"));
  const entry = Object.values(index.byCapabilityType.skills).find(item => item.id === "create-agent" && item.namespace === "canonical-reference");
  const method = path.join(framework, entry.path);
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-canonical-creator-origin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [variant, expected] of [
    ["canonical-relative", "completed"], ["business-impostor", "creator_method_source_mismatch"],
    ["forged-root-and-hash", "creator_provider_content_digest_mismatch"], ["readonly-canonical", "read_only"],
  ]) {
    const projectRoot = path.join(root, variant); mkdirSync(projectRoot);
    writeFileSync(path.join(projectRoot, "package.json"), "{}\n");
    const id = "review-bound-agent";
    const fake = path.join(projectRoot, "create-agent.md");
    writeFileSync(fake, "This business file is not the framework creator method.");
    const provider = { id: entry.id, type: "skills", source: "repo_canonical_capability_index", sourceRef: entry.relativePath,
      sourceRoot: projectRoot, contentDigest: hash(readFileSync(variant === "forged-root-and-hash" ? fake : method)) };
    const sourceRef = path.join(projectRoot, "prepared.toml");
    writeFileSync(sourceRef, `name = "${id}"\ndescription = "Bounded audit source"\ndeveloper_instructions = "Read source evidence; never publish or grant new permissions."\n`);
    const preview = copyProjectCapability({ projectDir: projectRoot, runtime: "codex", type: "agent", id, source: sourceRef, mode: "create" });
    const contentDigest = "sha256:" + hash(JSON.stringify(preview.capability.files.map(({ relPath, baselineHash }) => ({ relPath, baselineHash })).sort((a,b) => a.relPath.localeCompare(b.relPath))));
    const evidence = path.join(projectRoot, "evidence.json");
    writeFileSync(evidence, JSON.stringify({ evidenceClass: "explicit-source-binding-test", nativeInvocationVerified: false }));
    const artifact = { requestedCapability: id, capabilityType: "agent", runtime: "codex", projectRoot, sourceRef,
      creatorProviderId: provider.id, creatorMethodRef: variant === "business-impostor" ? fake : entry.relativePath,
      evidenceRefs: [evidence], contentDigest };
    const approvalRef = path.join(projectRoot, "approval.json");
    writeFileSync(approvalRef, JSON.stringify({ ...artifact, status: "approved" }));
    artifact.review = { status: "approved", approvalRef, contentDigest };
    const plan = buildProjectCustomizationPacket({ task: "请在当前项目新建 agent review-bound-agent，负责读取证据并拒绝发布或任何外部写入。",
      runId: variant, runtime: "codex", projectRoot, creationArtifacts: [artifact], outputLanguage: "en",
      orchestrationReport: { status: "pass", selectedExecutionRoute: { selectedCapabilityProviders: { agentCreation: provider }, ownerDiscoveryPacket: {} } },
      runtimeInvocationPlanPacket: { requiredBindings: [] } });
    assert.equal(plan.decisions[0].professionalRequirement, undefined);
    const result = executeProjectCustomizationPacket({ packet: plan, runtime: "codex", runId: variant, projectRoot,
      mutationMode: variant === "readonly-canonical" ? "read_only" : "auto" });
    if (["completed", "read_only"].includes(expected)) assert.equal(result.status, expected, variant);
    else assert.equal(result.execution.results[0].reason, expected, variant);
    assert.equal(result.execution.appliedCount, expected === "completed" ? 1 : 0, variant);
    assert.equal(existsSync(path.join(projectRoot, ".codex/agents", id + ".toml")), expected === "completed", variant);
  }
});
