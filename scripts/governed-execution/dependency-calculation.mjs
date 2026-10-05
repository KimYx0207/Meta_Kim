import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkedPath, componentHash, discoverDependencyAgentContracts } from "../dependency-agent-discovery.mjs";
import { runRouteQuery } from "../run-route-query.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const digest = (value) => createHash("sha256").update(value).digest("hex");
export const MAX_CALCULATION_INPUT_BYTES = 262144;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string");

function result(status, fields = {}) {
  return { schemaVersion: 1, status, toolInvoked: false, nativeAgentInvocation: false,
    modelSemanticAcceptance: false, externalActionsPerformed: false, ...fields };
}

// Validate transport and safety claims here; the reviewed capability owns domain
// fields, missing-material questions, typed receipt validation and presentation.
export function validateDeliveryEnvelope(value, tool, task) {
  assert(isObject(value));
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.tool, tool.id); assert.equal(value.toolVersion, tool.toolVersion);
  assert.equal(value.networkUsed, false); assert.equal(value.filesModified, false);
  assert(["completed", "partial", "invalid_input", "needs_input"].includes(value.status));
  assert.equal(typeof value.calculationPerformed, "boolean");
  assert(isObject(value.brief)); assert.equal(value.brief.request, task);
  assert(strings(value.missing)); assert(strings(value.questions));
  assert(Array.isArray(value.issues) && value.issues.every((issue) => isObject(issue) && typeof issue.code === "string"));
  assert(value.delivery === null || typeof value.delivery === "string");
  assert(isObject(value.handoff));
  assert(["ready", "needs_input", "blocked"].includes(value.handoff.status));
  assert(value.handoff.code === null || typeof value.handoff.code === "string");
  assert(strings(value.handoff.questions));
  if (value.status === "needs_input") {
    assert.equal(value.calculationPerformed, false); assert.equal(value.receipt, null);
    assert.equal(value.receiptSha256, null); assert.equal(value.receiptJson, null);
    assert(value.questions.length > 0); assert.notEqual(value.handoff.status, "ready");
  } else {
    assert.equal(value.calculationPerformed, true); assert(isObject(value.receipt));
    assert.equal(typeof value.receiptJson, "string");
    assert.equal(value.receiptSha256, digest(value.receiptJson));
    assert.deepEqual(JSON.parse(value.receiptJson), value.receipt);
    assert.equal(value.receipt.schemaVersion, 1); assert.equal(value.receipt.tool, tool.id);
    assert.equal(value.receipt.status, value.status);
    assert.equal(value.receipt.networkUsed, false); assert.equal(value.receipt.filesModified, false);
    if (value.status === "invalid_input") assert.notEqual(value.handoff.status, "ready");
  }
}

/** A deterministic read-only calculation is a host tool, not native Agent
 * execution. The host supplies the original request and explicit materials.
 * This bridge never invents conversation confirmation or executes arbitrary
 * dependency commands. Only reviewed script bytes can cross this boundary.
 */
export async function runDependencyCalculation({ task, inputJson, dependencyRoot = process.env.META_KIM_KIM_SERVICE_ROOT,
  runtime = process.env.META_KIM_RUNTIME_FAMILY, osTarget = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux" } = {}) {
  if (typeof task !== "string" || !task.trim() || task.length > 6000 || typeof inputJson !== "string"
    || Buffer.byteLength(inputJson) > MAX_CALCULATION_INPUT_BYTES) return result("invalid_input", { code: "invalid_request_envelope" });
  let materials;
  try { materials = JSON.parse(inputJson); } catch { return result("invalid_input", { code: "invalid_materials_json" }); }
  if (!materials || typeof materials !== "object" || Array.isArray(materials)) return result("invalid_input", { code: "materials_must_be_object" });
  runtime = runtime === "claude" ? "claude_code" : runtime;
  if (!["codex", "claude_code", "cursor", "openclaw"].includes(runtime)) {
    return result("unavailable", { code: "runtime_binding_required",
      nextAction: "Bind META_KIM_RUNTIME_FAMILY in the MCP server configuration to its actual host runtime." });
  }
  if (typeof dependencyRoot !== "string" || !path.isAbsolute(dependencyRoot)) {
    return result("unavailable", { code: "explicit_dependency_root_required", nextAction: "Configure META_KIM_KIM_SERVICE_ROOT with the existing Kim_Service checkout." });
  }
  const binding = { requestSha256: digest(task), inputSha256: digest(inputJson), intentSource: "host_supplied_request_and_materials" };
  let componentRoot, policy, tool, deliveryTool, sourceHash, route;
  const reviewedFiles = new Map();
  try {
    const sourceRoot = path.resolve(dependencyRoot);
    const real = await fs.realpath(sourceRoot);
    assert.equal(process.platform === "win32" ? real.toLowerCase() : real,
      process.platform === "win32" ? sourceRoot.toLowerCase() : sourceRoot);
    const projects = JSON.parse(await fs.readFile(path.join(repoRoot, "config/capability-index/dependency-project-registry.json"), "utf8")).projects;
    const env = { ...process.env, META_KIM_KIM_SERVICE_ROOT: sourceRoot };
    const discovered = await discoverDependencyAgentContracts({ projects, projectRoot: repoRoot, environment: env });
    route = await runRouteQuery({ task, runtime, os: osTarget, env });
    if (route.entryClassification?.path === "fast_path") return result("not_applicable", { code: "request_is_not_execution", binding });
    const policies = JSON.parse(await fs.readFile(path.join(repoRoot, "config/contracts/dependency-calculation-tools.json"), "utf8"));
    policy = policies.tools.find((entry) => entry.ownerId === route.recommendedRoute?.owner);
    if (!policy) return result("unavailable", { code: "selected_owner_has_no_reviewed_calculator", binding });
    const owner = discovered.agents.find((entry) => entry.id === policy.ownerId);
    const routed = route.recommendedRoute.selectedCapabilityProviders?.agent;
    assert(owner && routed?.source === "dependency_agent_contract");
    assert.equal(routed.contentDigest, owner.contentDigest);
    assert.equal(routed.ownerContract.componentContentSha256, owner.ownerContract.componentContentSha256);
    componentRoot = await checkedPath(sourceRoot, `agents/${policy.componentId}`, true);
    sourceHash = await componentHash(componentRoot);
    assert.equal(sourceHash, owner.ownerContract.componentContentSha256);
    const contractBytes = await fs.readFile(await checkedPath(componentRoot, policy.contractFile));
    assert.equal(digest(contractBytes), policy.contractSha256, "calculator contract has not been reviewed");
    tool = JSON.parse(contractBytes);
    assert.equal(tool.componentId, policy.componentId);
    assert.equal(owner.ownerContract.helperContract, policy.contractFile);
    assert.equal(tool.schemaVersion, 1);
    assert.equal(tool.invocation.shell, false);
    const script = await fs.readFile(await checkedPath(componentRoot, tool.invocation.entrypoint));
    assert.equal(digest(script), policy.scriptSha256, "calculator script has not been reviewed");
    if (!policy.deliveryContractFile || !owner.ownerContract.deliveryContract) return result("unavailable", {
      code: "reviewed_delivery_contract_required", binding,
      nextAction: "Use a reviewed capability version with a delivery contract; the original calculation contract remains readable." });
    assert.equal(owner.ownerContract.deliveryContract, policy.deliveryContractFile);
    const deliveryBytes = await fs.readFile(await checkedPath(componentRoot, policy.deliveryContractFile));
    assert.equal(digest(deliveryBytes), policy.deliveryContractSha256, "delivery contract has not been reviewed");
    deliveryTool = JSON.parse(deliveryBytes);
    assert.equal(deliveryTool.schemaVersion, 1);
    assert.equal(deliveryTool.protocol, "calculation-delivery-v1");
    assert.equal(deliveryTool.invocation.type, "local_cli");
    assert.equal(deliveryTool.invocation.runtime, "python");
    assert.equal(deliveryTool.invocation.shell, false);
    assert.equal(deliveryTool.invocation.inputTransport, "stdin_json");
    assert.equal(deliveryTool.invocation.outputTransport, "stdout_json");
    assert.deepEqual(deliveryTool.invocation.argv, ["--input-json", "-"]);
    assert.deepEqual(deliveryTool.sideEffects, []);
    assert.equal(deliveryTool.networkUsed, false); assert.equal(deliveryTool.filesModified, false);
    assert(Number.isSafeInteger(deliveryTool.maxInputBytes) && deliveryTool.maxInputBytes > 0
      && deliveryTool.maxInputBytes <= MAX_CALCULATION_INPUT_BYTES);
    assert(Array.isArray(deliveryTool.files) && deliveryTool.files.length > 0 && deliveryTool.files.length <= 16);
    assert.equal(new Set(deliveryTool.files).size, deliveryTool.files.length);
    assert.deepEqual([...deliveryTool.files].sort(), Object.keys(policy.deliveryFilesSha256).sort());
    assert(deliveryTool.files.includes(deliveryTool.invocation.entrypoint));
    assert(deliveryTool.files.includes(tool.invocation.entrypoint));
    for (const relative of deliveryTool.files) {
      // Preserve relative module layout in a fresh snapshot, never host paths.
      assert(typeof relative === "string" && /^[a-zA-Z0-9_./-]+$/.test(relative)
        && !path.posix.isAbsolute(relative) && relative.split("/").every((part) => part && part !== "." && part !== ".."));
      const bytes = await fs.readFile(await checkedPath(componentRoot, relative));
      assert.equal(digest(bytes), policy.deliveryFilesSha256[relative], "delivery file has not been reviewed");
      reviewedFiles.set(relative, bytes);
    }
  } catch {
    return result("unavailable", { code: "dependency_source_or_route_not_verified", binding });
  }
  const brief = { request: task };
  const selectedRoute = { owner: policy.ownerId, runtime, entryPath: route.entryClassification.path,
    source: "existing_execution_route", sourceContentSha256: sourceHash, toolId: tool.id };
  if (Buffer.byteLength(inputJson, "utf8") > deliveryTool.maxInputBytes) {
    return result("invalid_input", { code: "calculation_materials_size_limit", maxBytes: deliveryTool.maxInputBytes,
      binding, brief, route: selectedRoute });
  }
  const gate = route.routeExecutionGate;
  if (gate?.handoffStatus === "awaiting_native_choice" && route.userChoiceNeeded) return result("needs_input", { binding, brief, route: selectedRoute,
    code: "material_route_choice_required", questions: [route.requiredUserChoiceIfAny ?? "请确认影响本次结果的路径选择。"] });
  // Route readiness is required before the MCP host starts its bounded tool;
  // it does not claim native Agent execution or replace host permissions.
  if (gate?.handoffStatus !== "ready_for_host_handoff" || gate.routeCompatible !== true || gate.canHandoffToHost !== true) {
    return result("unavailable", { code: "route_not_ready_for_host_handoff", binding, brief, route: selectedRoute,
      gate: { handoffStatus: gate?.handoffStatus ?? "missing", blockedBy: gate?.blockedBy ?? [],
        returnToStage: gate?.returnToStage ?? "Fetch", reason: gate?.reason ?? "Route handoff evidence is missing." } });
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-calculation-"));
  try {
    // Execute a snapshot of the reviewed bytes; a later dependency edit cannot
    // swap the script after verification. This is not a hostile same-user sandbox.
    for (const [relative, bytes] of reviewedFiles) {
      const destination = path.join(temporary, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes, { flag: "wx" });
    }
    const entrypoint = path.join(temporary, deliveryTool.invocation.entrypoint);
    const python = process.platform === "win32" ? "python" : "python3";
    const env = { PATH: process.env.PATH ?? "", HOME: temporary, USERPROFILE: temporary,
      TMPDIR: temporary, TEMP: temporary, TMP: temporary, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" };
    for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR"]) if (process.env[key]) env[key] = process.env[key];
    const run = spawnSync(python, ["-I", "-B", entrypoint, ...deliveryTool.invocation.argv], {
      cwd: temporary, env, shell: false, windowsHide: true, encoding: "utf8", input: JSON.stringify({ task, inputJson }),
      // Receipt JSON and its escaped byte-preserving transport are both bounded.
      timeout: 10000, maxBuffer: 4 * 1024 * 1024,
    });
    if (run.error || run.signal || ![0, 2].includes(run.status) || run.stderr) {
      return result("unavailable", { toolInvoked: Boolean(run.pid), code: "calculation_process_failed", binding, brief, route: selectedRoute,
        diagnostics: { exitCode: run.status, signal: run.signal ?? null, timedOut: run.error?.code === "ETIMEDOUT" } });
    }
    let delivered;
    try {
      delivered = JSON.parse(run.stdout);
      validateDeliveryEnvelope(delivered, tool, task);
      assert.equal(run.status, delivered.status === "invalid_input" ? 2 : 0);
      assert.equal(await componentHash(componentRoot), sourceHash);
    } catch { return result("failed", { toolInvoked: true, code: "calculation_receipt_or_source_changed", binding, brief, route: selectedRoute }); }
    return result(delivered.status, { toolInvoked: delivered.calculationPerformed, binding,
      brief: delivered.brief, route: selectedRoute, questions: delivered.questions,
      missing: delivered.missing, issues: delivered.issues, handoff: delivered.handoff,
      ...(delivered.receipt ? { receipt: delivered.receipt } : {}),
      execution: { kind: delivered.calculationPerformed ? "real_python_calculation" : "reviewed_material_validation",
        scriptSha256: policy.scriptSha256, contractSha256: policy.contractSha256,
        deliveryContractSha256: policy.deliveryContractSha256,
        deliveryFilesSha256: policy.deliveryFilesSha256,
        exitCode: run.status, outputSha256: digest(run.stdout), sourceUnchanged: true },
      delivery: delivered.delivery });
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
