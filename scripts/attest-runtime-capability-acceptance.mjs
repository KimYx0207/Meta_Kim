#!/usr/bin/env node
import path from "node:path";
import { writeRuntimeCapabilityAcceptanceAttempt } from "./runtime-capability-acceptance.mjs";

function value(args, name, fallback = null) {
  const equals = args.find((entry) => entry.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

export function parseRuntimeAcceptanceCliArgs(args) {
  const valueNames = new Set(["--report", "--source-kind", "--runtime", "--capability", "--mode", "--project-root", "--profile", "--attempt-id", "--correlation-id"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") continue;
    if (["--release-grade", "--release-audit", "--release-verification"].some((name) => arg === name || arg.startsWith(`${name}=`))) {
      throw new Error("external import cannot create or promote release-grade acceptance");
    }
    const equalsName = [...valueNames].find((name) => arg.startsWith(`${name}=`));
    if (equalsName) continue;
    if (!valueNames.has(arg)) throw new Error(`unknown option ${arg}`);
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${arg} requires a value`);
    index += 1;
  }
  const required = ["--report", "--source-kind", "--runtime", "--capability"];
  for (const name of required) if (!value(args, name)) throw new Error(`${name} is required`);
  const callerRoot = path.resolve(value(args, "--project-root", process.env.META_KIM_CALLER_CWD || process.cwd()));
  const resolveCallerPath = (input) => input ? path.resolve(callerRoot, input) : null;
  const sourceKind = value(args, "--source-kind");
  if (!["runtime_live_fuse", "packed_update_global_readback"].includes(sourceKind)) throw new Error("unsupported external source kind");
  return {
    projectRoot: callerRoot,
    profile: value(args, "--profile", process.env.META_KIM_PROFILE),
    reportPath: resolveCallerPath(value(args, "--report")),
    sourceKind,
    runtime: value(args, "--runtime"),
    capability: value(args, "--capability"),
    mode: value(args, "--mode", "interactive_host"),
    attemptId: value(args, "--attempt-id", undefined),
    correlationId: value(args, "--correlation-id", undefined),
    releaseGrade: false,
    releaseAuditPath: null,
    releaseVerificationPath: null,
  };
}

export function runRuntimeAcceptanceCli(args = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: meta-kim runtime accept --report <file> --source-kind runtime_live_fuse|packed_update_global_readback --runtime <runtime> --capability <capability> [--mode interactive_host] [--profile <name>] [--project-root <dir>]\n\nImported reports are stored as reference-only observations. Only a Meta_Kim controlled producer can create executable acceptance. Release promotion is performed by the controlled release lifecycle.\n");
    return;
  }
  const result = writeRuntimeCapabilityAcceptanceAttempt(parseRuntimeAcceptanceCliArgs(args));
  process.stdout.write(`${JSON.stringify({
    ok: true,
    observationOnly: true,
    executable: false,
    attemptId: result.record.attemptId,
    correlationId: result.record.correlationId,
    runtime: result.record.runtime,
    capability: result.record.capability,
    mode: result.record.mode,
    observedAt: result.record.observedAt,
    releaseGrade: false,
  }, null, 2)}\n`);
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(import.meta.filename)) {
  try { runRuntimeAcceptanceCli(); }
  catch (error) {
    process.stderr.write(`meta-kim runtime accept: ${error.message}\n`);
    process.exitCode = 1;
  }
}
