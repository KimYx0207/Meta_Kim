import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  aggregateLegacyCapabilitySummary,
  resolveRuntimeCapabilityClaim,
} from "../../scripts/runtime-capability-claims.mjs";
import {
  digestRepositorySource,
  validateRuntimeCapabilityClaims,
} from "../../scripts/runtime-capability-evidence.mjs";

const matrixPath = new URL("../../config/runtime-capability-matrix.json", import.meta.url);
const ledgerPath = new URL("../../config/runtime-capability-evidence.json", import.meta.url);

function fixtures() {
  return {
    matrix: JSON.parse(readFileSync(matrixPath, "utf8")),
    ledger: JSON.parse(readFileSync(ledgerPath, "utf8")),
  };
}

function row(matrix, runtime, capability) {
  return matrix.platforms
    .find((entry) => entry.platform === runtime)
    .capabilities.find((entry) => entry.capability === capability);
}

function issuesFor(matrix, ledger, allowedEvidenceRoots = undefined) {
  return validateRuntimeCapabilityClaims(matrix, ledger, {
    now: "2026-07-28T12:00:00.000Z",
    staleAfterDays: 30,
    timeZone: "Asia/Shanghai",
    allowedEvidenceRoots,
  });
}

function setLegacySummary(record) {
  Object.assign(record, aggregateLegacyCapabilitySummary(record));
}

function attachAcceptance({ matrix, ledger, root, runtime = "codex", capability = "shell", mode = "interactive_host" }) {
  const correlationId = `${runtime}-${capability.replaceAll(" ", "-")}-${mode}-correlation`;
  const attemptId = "attempt-1";
  const acceptance = {
    digestBoundSnapshot: true,
    outcome: "pass",
    runtime,
    capability,
    mode,
    correlationId,
    attemptId,
    observedAt: "2026-07-28T10:00:00.000Z",
  };
  const artifactPath = path.join(root, "acceptance.json");
  const bytes = Buffer.from(`${JSON.stringify(acceptance, null, 2)}\n`);
  writeFileSync(artifactPath, bytes);
  const observation = {
    id: `${runtime}.acceptance.${capability}.${mode}`,
    runtime,
    capabilities: [capability],
    observationClass: "local_acceptance",
    runtimeModes: [mode],
    observedAt: "2026-07-28T10:00:00.000Z",
    sourceRefs: ["immutable acceptance artifact"],
    artifact: {
      path: artifactPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      correlationId,
      attemptId,
    },
  };
  ledger.observations.push(observation);
  const record = row(matrix, runtime, capability);
  record.hostSupport = "native";
  record.hostConfidence = "verified_local";
  record.requiredModes = [...new Set([...record.requiredModes, mode])];
  record.claimsByMode[mode] = {
    hostSupport: "native",
    hostConfidence: "verified_local",
    metaKimIntegration: "projected",
    acceptanceRequirement: "required",
    acceptanceState: "accepted",
    routeEligibility: "executable",
    evidenceRefs: [observation.id],
  };
  setLegacySummary(record);
  return { observation, artifactPath, acceptance, record };
}

test("P-130 repository evidence digest is stable across LF and CRLF distributions", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-p130-eol-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "runtime-hook.mjs");

  writeFileSync(sourcePath, "const first = 1;\nconst second = 2;\n", "utf8");
  const lfDigest = digestRepositorySource(root);

  writeFileSync(sourcePath, "const first = 1;\r\nconst second = 2;\r\n", "utf8");
  assert.equal(digestRepositorySource(root), lfDigest);

  writeFileSync(sourcePath, Buffer.from([0xff, 0xfe, 0xfd]));
  const firstBinaryDigest = digestRepositorySource(root);
  writeFileSync(sourcePath, Buffer.from([0xff, 0xfe, 0xfc]));
  assert.notEqual(digestRepositorySource(root), firstBinaryDigest);
});

test("P-130 v2 baseline separates host, integration, acceptance, and legacy summaries", () => {
  const { matrix, ledger } = fixtures();
  assert.deepEqual(issuesFor(matrix, ledger), []);
  assert.equal(matrix.schemaVersion, 2);
  assert.equal(Object.hasOwn(matrix, "lastVerifiedAt"), false);
  assert.equal(ledger.authorityBoundary, "observations_only");
  const cursor = row(matrix, "cursor", "native choice surface");
  assert.equal(cursor.hostSupport, "native");
  assert.equal(cursor.support, "partial");
  assert.equal(resolveRuntimeCapabilityClaim(matrix, {
    runtime: "cursor",
    capability: "native choice surface",
    mode: "interactive_host",
  }).executable, false);
});

test("P-130 requires exact claimsByMode coverage and mode-specific evidence", () => {
  const { matrix, ledger } = fixtures();
  delete row(matrix, "codex", "agent").claimsByMode.headless_live;
  assert.match(issuesFor(matrix, ledger).join("\n"), /claimsByMode must cover every declared runtime mode exactly/u);

  const second = fixtures();
  const claim = row(second.matrix, "codex", "agent").claimsByMode.interactive_host;
  claim.evidenceRefs = ["codex.repo.projection.2026-07-28"];
  assert.match(issuesFor(second.matrix, second.ledger).join("\n"), /host support requires docs or correlated acceptance evidence/u);

  const third = fixtures();
  const integrationClaim = row(third.matrix, "codex", "agent").claimsByMode.interactive_host;
  integrationClaim.evidenceRefs = ["codex.docs.subagents.2026-07-28"];
  assert.match(issuesFor(third.matrix, third.ledger).join("\n"), /integration conclusion requires repository projection or correlated acceptance evidence/u);
});

test("P-130 rejects version or presence evidence as native behavioral proof", () => {
  const { matrix, ledger } = fixtures();
  const record = row(matrix, "codex", "shell");
  ledger.observations.push({
    id: "codex.presence.shell",
    runtime: "codex",
    capabilities: ["shell"],
    observationClass: "presence_only",
    runtimeModes: ["interactive_host"],
    observedAt: "2026-07-28",
    sourceRefs: ["codex --version"],
  });
  record.claimsByMode.interactive_host = {
    hostSupport: "native",
    hostConfidence: "verified_local",
    metaKimIntegration: "projected",
    acceptanceRequirement: "required",
    acceptanceState: "accepted",
    routeEligibility: "executable",
    evidenceRefs: ["codex.presence.shell"],
  };
  setLegacySummary(record);
  const issues = issuesFor(matrix, ledger).join("\n");
  assert.match(issues, /host support requires docs or correlated acceptance evidence/u);
  assert.match(issues, /accepted state requires correlated local\/live evidence/u);
});

test("P-130 keeps acceptance out of the static ledger and rejects tampering", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-p130-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { matrix, ledger } = fixtures();
  const attached = attachAcceptance({ matrix, ledger, root });
  assert.match(issuesFor(matrix, ledger, [root]).join("\n"), /must not be stored in the canonical static ledger/u);

  attached.observation.artifact.sha256 = "0".repeat(64);
  assert.match(issuesFor(matrix, ledger, [root]).join("\n"), /SHA-256 mismatch/u);
  attached.observation.artifact.sha256 = createHash("sha256").update(readFileSync(attached.artifactPath)).digest("hex");
  attached.acceptance.runtime = "cursor";
  const tampered = Buffer.from(`${JSON.stringify(attached.acceptance, null, 2)}\n`);
  writeFileSync(attached.artifactPath, tampered);
  attached.observation.artifact.sha256 = createHash("sha256").update(tampered).digest("hex");
  assert.match(issuesFor(matrix, ledger, [root]).join("\n"), /runtime binding mismatch/u);

  for (const [field, value, expected] of [
    ["runtime", "codex", null],
    ["capability", "filesystem", /capability binding mismatch/u],
    ["mode", "headless_live", /mode binding mismatch/u],
    ["digestBoundSnapshot", false, /must be a digest-bound snapshot with pass outcome/u],
    ["attemptId", "wrong-attempt", /attemptId binding mismatch/u],
  ]) {
    attached.acceptance[field] = value;
    const changed = Buffer.from(`${JSON.stringify(attached.acceptance, null, 2)}\n`);
    writeFileSync(attached.artifactPath, changed);
    attached.observation.artifact.sha256 = createHash("sha256").update(changed).digest("hex");
    if (expected) assert.match(issuesFor(matrix, ledger, [root]).join("\n"), expected);
  }
});

test("P-130 rejects missing, escaped, and duplicate-correlated acceptance artifacts", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-p130-"));
  const outsideRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-p130-outside-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  });
  const first = fixtures();
  const attached = attachAcceptance({ ...first, root });
  attached.observation.artifact.path = path.join(root, "missing.json");
  assert.match(issuesFor(first.matrix, first.ledger, [root]).join("\n"), /artifact file does not exist/u);

  const escapedArtifact = path.join(outsideRoot, "acceptance.json");
  writeFileSync(escapedArtifact, readFileSync(attached.artifactPath));
  attached.observation.artifact.path = escapedArtifact;
  assert.match(issuesFor(first.matrix, first.ledger, [root]).join("\n"), /escapes the allowed evidence root/u);

  const second = fixtures();
  const secondAttached = attachAcceptance({ ...second, root });
  second.ledger.observations.push({
    ...structuredClone(secondAttached.observation),
    id: "codex.acceptance.duplicate",
  });
  assert.match(issuesFor(second.matrix, second.ledger, [root]).join("\n"), /duplicates acceptance correlationId/u);

  const third = fixtures();
  const thirdAttached = attachAcceptance({ ...third, root });
  thirdAttached.observation.capabilities.push("filesystem");
  assert.match(issuesFor(third.matrix, third.ledger, [root]).join("\n"), /must bind exactly one capability and one runtime mode/u);
});

test("P-130 rejects arbitrary HTTPS official sources and future evidence", () => {
  const { matrix, ledger } = fixtures();
  const docs = ledger.observations.find((entry) => entry.id === "codex.docs.subagents.2026-07-28");
  docs.sourceRefs = ["https://evil.example/codex/subagents"];
  assert.match(issuesFor(matrix, ledger).join("\n"), /non-allowlisted official documentation URL/u);

  const second = fixtures();
  second.ledger.observations[0].observedAt = "2026-07-29";
  assert.match(issuesFor(second.matrix, second.ledger).join("\n"), /future-dated/u);

  for (const invalidUrl of [
    "https://user@developers.openai.com/codex/subagents",
    "https://developers.openai.com:444/codex/subagents",
    "https://developers.openai.com/codex/mcp",
  ]) {
    const invalid = fixtures();
    invalid.ledger.observations.find((entry) => entry.id === "codex.docs.subagents.2026-07-28").sourceRefs = [invalidUrl];
    assert.match(issuesFor(invalid.matrix, invalid.ledger).join("\n"), /non-allowlisted|does not prove capability/u);
  }

  const swappedOpenClaw = fixtures();
  swappedOpenClaw.ledger.observations.find((entry) => entry.id === "openclaw.docs.agents.2026-07-28").sourceRefs = ["https://docs.openclaw.ai/cli/mcp"];
  assert.match(issuesFor(swappedOpenClaw.matrix, swappedOpenClaw.ledger).join("\n"), /does not prove capability agent/u);
});

test("P-130 binds repository projection sources by containment and SHA-256", () => {
  const wrongDigest = fixtures();
  wrongDigest.ledger.observations.find((entry) => entry.id === "codex.repo.projection.2026-07-28").sourceArtifacts[0].sha256 = "0".repeat(64);
  assert.match(issuesFor(wrongDigest.matrix, wrongDigest.ledger).join("\n"), /SHA-256 mismatch/u);

  const external = fixtures();
  const projection = external.ledger.observations.find((entry) => entry.id === "codex.repo.projection.2026-07-28");
  projection.sourceRefs[0] = "../package.json";
  projection.sourceArtifacts[0].path = "../package.json";
  assert.match(issuesFor(external.matrix, external.ledger).join("\n"), /resolve inside an allowlisted repository asset/u);
});

test("P-130 rejects circular or stale conservative review evidence", () => {
  const { matrix, ledger } = fixtures();
  const review = ledger.observations.find((entry) => entry.observationClass === "conservative_review");
  review.sourceRefs = ["config/runtime-capability-matrix.json"];
  assert.match(issuesFor(matrix, ledger).join("\n"), /cannot cite the matrix as self-proof/u);

  const second = fixtures();
  const staleReview = second.ledger.observations.find((entry) => entry.id === "codex.review.conservative.2026-07-28");
  staleReview.observedAt = "2026-01-01";
  assert.match(issuesFor(second.matrix, second.ledger).join("\n"), /must bind fresh conservative_review evidence/u);
});

test("P-130 rejects chat fallback completion and Cursor docs-only promotion", () => {
  for (const runtime of ["claude_code", "codex"]) {
    const { matrix, ledger } = fixtures();
    row(matrix, runtime, "chat decision card fallback").claimsByMode.interactive_host.completionEligible = true;
    assert.match(issuesFor(matrix, ledger).join("\n"), /chat fallback can never complete native choice/u);
  }

  const nativeBypass = fixtures();
  const native = row(nativeBypass.matrix, "codex", "native choice surface");
  native.requiredModes = native.requiredModes.filter((mode) => mode !== "interactive_host");
  assert.match(issuesFor(nativeBypass.matrix, nativeBypass.ledger).join("\n"), /native choice interactive mode must remain required and unaccepted/u);

  const cursor = fixtures();
  const claim = row(cursor.matrix, "cursor", "agent").claimsByMode.interactive_host;
  claim.acceptanceState = "accepted";
  claim.routeEligibility = "executable";
  setLegacySummary(row(cursor.matrix, "cursor", "agent"));
  assert.match(issuesFor(cursor.matrix, cursor.ledger).join("\n"), /Cursor must remain product\/live unaccepted/u);
});

test("P-130 pins exact OpenClaw docs and declarative hook boundary", () => {
  const { matrix, ledger } = fixtures();
  ledger.observations.find((entry) => entry.id === "openclaw.docs.apply_patch.2026-07-28").sourceRefs = ["https://docs.openclaw.ai/tools"];
  assert.match(issuesFor(matrix, ledger).join("\n"), /OpenClaw canonical documentation URL missing: https:\/\/docs\.openclaw\.ai\/tools\/apply-patch/u);

  const second = fixtures();
  row(second.matrix, "openclaw", "hook").claimsByMode.interactive_host.metaKimIntegration = "projected";
  assert.match(issuesFor(second.matrix, second.ledger).join("\n"), /must remain distinct from uninstalled typed tool blocking/u);

  const declarativeClaim = {
    ...row(matrix, "openclaw", "hook").claimsByMode.interactive_host,
    acceptanceRequirement: "not_required",
    acceptanceState: "not_applicable",
    routeEligibility: "executable",
  };
  assert.equal(resolveRuntimeCapabilityClaim({
    platforms: [{
      platform: "openclaw",
      capabilities: [{ capability: "hook", claimsByMode: { interactive_host: declarativeClaim } }],
    }],
  }, { runtime: "openclaw", capability: "hook", mode: "interactive_host" }).executable, false);
});
