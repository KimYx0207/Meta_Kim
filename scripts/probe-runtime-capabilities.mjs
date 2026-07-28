#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { commandProbe, detectHostOs, exists, readJson, repoPath, stateDir, writeJson } from "./governance-lib.mjs";
import { redactProbePath } from "./runtime-capability-evidence.mjs";

const args = new Set(process.argv.slice(2));
const probePath = path.join(stateDir, "runtime-capability-probe.json");

function captureVersion(command) {
  const result =
    process.platform === "win32"
      ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `${command} --version`], {
          encoding: "utf8",
          shell: false,
        })
      : spawnSync(command, ["--version"], { encoding: "utf8", shell: false });
  if (result.status !== 0) return null;
  return (result.stdout || result.stderr).split(/\r?\n/).find(Boolean) ?? null;
}

async function inspectRuntime(id, command, projectPaths, globalPaths) {
  const cmd = commandProbe(command);
  const project = {};
  for (const rel of projectPaths) {
    project[rel] = await exists(repoPath(rel));
  }
  const global = {};
  for (const p of globalPaths) {
    global[p] = await exists(p.replace(/^~(?=$|\/|\\)/, process.env.USERPROFILE || process.env.HOME || ""));
  }
  return {
    id,
    observationClass: "presence_only",
    runtimeMode: "compatibility_presence",
    command: {
      ...cmd,
      source: redactProbePath(cmd.source, {
        homeRoot: process.env.USERPROFILE || process.env.HOME || null,
        stateRoot: stateDir,
      }),
      version: cmd.available ? (cmd.version ?? captureVersion(command)) : null,
    },
    project,
    global,
    limitations: [
      "Availability, version, and path presence only.",
      "This observation never upgrades matrix support, confidence, integration, or acceptance conclusions.",
    ],
  };
}

async function buildProbe() {
  const generatedAt = new Date().toISOString();
  const detectedHost = detectHostOs();
  const payload = {
    schemaVersion: "2.0.0",
    probeKind: "availability_presence_only",
    authorityBoundary: "observation_only_no_claim_upgrade",
    runtimeMode: "compatibility_presence",
    generatedAt,
    host: {
      platform: detectedHost.platform,
      normalized: detectedHost.normalized,
      isWsl2: detectedHost.isWsl2,
      arch: detectedHost.arch,
      release: detectedHost.release,
    },
    runtimes: {
      claude_code: await inspectRuntime("claude_code", "claude", [".claude/settings.json", ".claude/agents", ".claude/skills", ".claude/hooks", ".mcp.json"], ["~/.claude"]),
      codex: await inspectRuntime("codex", "codex", [".codex/config.toml", ".codex/hooks.json", ".codex/agents", ".agents/skills", ".mcp.json"], ["~/.codex"]),
      openclaw: await inspectRuntime("openclaw", "openclaw", ["openclaw/openclaw.template.json", "openclaw/workspaces", "openclaw/skills", "openclaw/hooks"], ["~/.openclaw"]),
      cursor: await inspectRuntime("cursor", "cursor", [".cursor/mcp.json", ".cursor/hooks.json", ".cursor/agents", ".cursor/rules", ".cursor/skills"], ["~/.cursor"]),
    },
  };
  const digestInput = JSON.stringify(payload);
  return {
    ...payload,
    artifact: {
      path: redactProbePath(probePath, {
        homeRoot: detectedHost.homeDir,
        stateRoot: stateDir,
      }),
      sha256: createHash("sha256").update(digestInput).digest("hex"),
      correlationId: `runtime-presence-${generatedAt}`,
      digestScope: "probe payload before artifact metadata",
    },
  };
}

function matrixSupportFor(matrix, platform) {
  const entry = matrix.platforms.find((item) => item.platform === platform);
  if (!entry) return new Map();
  const map = new Map();
  for (const capability of entry.capabilities ?? []) {
    map.set(capability.capability, capability.support);
  }
  for (const [support, names] of Object.entries(entry.capabilityTemplate ?? {})) {
    if (!Array.isArray(names)) continue;
    for (const name of names) map.set(name, support);
  }
  return map;
}

async function check(probe) {
  if (probe.probeKind !== "availability_presence_only" || probe.authorityBoundary !== "observation_only_no_claim_upgrade") {
    throw new Error("runtime probe must identify itself as observation-only availability/presence evidence");
  }
  const { artifact, ...digestPayload } = probe;
  const expectedDigest = createHash("sha256").update(JSON.stringify(digestPayload)).digest("hex");
  if (artifact?.digestScope !== "probe payload before artifact metadata" || artifact?.sha256 !== expectedDigest) {
    throw new Error("runtime probe digest is not reproducible from its declared payload scope");
  }
  if (/[A-Za-z]:[\\/]|\/(?:Users|home)\//u.test(JSON.stringify(probe))) {
    throw new Error("runtime probe must redact absolute repository and home paths");
  }
  const matrix = await readJson("config/runtime-capability-matrix.json");
  for (const platform of ["claude_code", "codex", "openclaw", "cursor"]) {
    const support = matrixSupportFor(matrix, platform);
    if (support.size === 0) {
      throw new Error(`runtime-capability-matrix missing ${platform}`);
    }
    for (const capability of matrix.capabilityNames ?? []) {
      if (!support.has(capability)) {
        throw new Error(`${platform} missing capability ${capability}`);
      }
    }
  }
  for (const [platform, runtime] of Object.entries(probe.runtimes)) {
    if (runtime.observationClass !== "presence_only" || runtime.runtimeMode !== "compatibility_presence") {
      throw new Error(`${platform} probe must remain presence-only`);
    }
    if (!Array.isArray(runtime.limitations) || !runtime.limitations.some((item) => item.includes("never upgrades"))) {
      throw new Error(`${platform} probe must declare its no-upgrade boundary`);
    }
  }
}

const probe = await buildProbe();
await writeJson(probePath, probe);
if (args.has("--check")) {
  await check(probe);
}
if (args.has("--json")) {
  console.log(JSON.stringify(probe, null, 2));
} else {
  console.log(`Runtime capability probe written to ${probePath}`);
}
