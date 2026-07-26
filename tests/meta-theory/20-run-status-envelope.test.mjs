import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJson, readFile as readRepoFile } from "./_helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function createDirectoryLink(target, linkPath) {
  try {
    await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return false;
    throw error;
  }
}

function createLegacyEnvelope(spine, runId, options = {}) {
  const state = {
    ...spine.createInitialState({ taskClassification: "legacy_test" }),
    runId,
  };
  if (options.active === false) {
    state.active = false;
    state.lifecycleStatus = "session_stopped";
    state.deactivationReason = "session_stop";
    state.deactivatedAt = "2026-06-20T18:27:05.423Z";
  }
  const envelope = {
    ...spine.createMetaRunStatusEnvelope(state),
    schemaVersion: 1,
    ...options.overrides,
  };
  delete envelope.taskFingerprint;
  delete envelope.taskIdentitySource;
  delete envelope.lifecycleStatus;
  if (options.withoutAuthority === true) {
    delete envelope.authorityMode;
    delete envelope.publicReadyAuthority;
  }
  return envelope;
}

async function waitForFile(filePath, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(filePath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

/**
 * Create one task identity in a fresh Node process so Windows exercises the
 * real cross-process exclusive-create path rather than only one event loop.
 */
function createTaskIdentityInChild(moduleUrl, cwd, profile, prompt) {
  const source = [
    `import { createProjectTaskIdentity } from ${JSON.stringify(moduleUrl)};`,
    "const result = await createProjectTaskIdentity(process.argv[1], process.argv[3], { profile: process.argv[2] });",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", source, cwd, profile, prompt],
      { encoding: "utf8", windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Task identity child exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Invalid task identity child output: ${stdout}`, { cause: error }));
      }
    });
  });
}

describe("meta-theory run status envelope", () => {
  test("workflow contract defines cross-runtime public run status", async () => {
    const contract = await readJson("config/contracts/workflow-contract.json");
    const envelope = contract.runDiscipline?.runStatusEnvelope;

    assert.ok(envelope?.enabled, "runStatusEnvelope must be enabled");
    assert.equal(envelope.schemaVersion, 2);
    assert.equal(
      envelope.stateFiles?.activeRun,
      ".meta-kim/state/{profile}/active-run.json",
    );
    assert.equal(
      envelope.stateFiles?.perRunStatus,
      ".meta-kim/state/{profile}/runs/{runId}/status.json",
    );
    assert.equal(
      envelope.stateFiles?.lifecycleMigrationMarker,
      ".meta-kim/state/{profile}/migrations/run-status-lifecycle-v1.json",
    );
    assert.equal(
      envelope.stateFiles?.lifecycleMigrationCompletionSidecar,
      ".meta-kim/state/{profile}/migrations/run-status-lifecycle-v1.managed-completion.json",
    );
    assert.equal(
      envelope.stateFiles?.privateTaskIdentityKey,
      ".meta-kim/state/{profile}/private/task-identity-key.json",
    );
    assert.equal(envelope.pathPolicy?.crossPlatform, true);
    assert.equal(envelope.pathPolicy?.useNodePathJoin, true);
    assert.equal(envelope.pathPolicy?.mustStayWithin, ".meta-kim/state");
    assert.equal(envelope.publicDisplayPolicy?.primaryDisplay, "conversation_notice");
    assert.equal(envelope.publicDisplayPolicy?.popupRequired, false);
    assert.deepEqual(envelope.authorityPolicy?.authorityModeEnum, [
      "managed_runtime_spine",
      "hook_observed_advisory",
    ]);
    assert.equal(envelope.authorityPolicy?.publicReadyAuthority, false);

    for (const field of [
      "active",
      "lifecycleStatus",
      "runId",
      "taskFingerprint",
      "taskIdentitySource",
      "taskClassification",
      "currentStage",
      "stageIndex",
      "stageTotal",
      "percent",
      "completed",
      "next",
      "blockedOn",
      "authorityMode",
      "driverMode",
      "hookGateMode",
      "publicReadyAuthority",
      "publicReadyBoundary",
      "deactivatedAt",
      "deactivationReason",
      "supersededByRunId",
      "archivedAt",
      "archiveReason",
      "continuationBoundary",
      "surfaceMode",
      "resolvedOutputLanguage",
      "languageResolution",
      "publicSurface",
      "publicLabels",
      "stagePurpose",
      "stagePurposeKey",
    ]) {
      assert.ok(
        envelope.requiredFields.includes(field),
        `runStatusEnvelope must require ${field}`,
      );
    }

    assert.ok(envelope.lifecycleStatusEnum.includes("archived_legacy"));
    assert.ok(envelope.deactivationReasonEnum.includes("superseded_by_new_prompt"));
    assert.ok(envelope.taskIdentitySourceEnum.includes("unrecoverable_legacy"));
    assert.ok(envelope.taskIdentitySourceEnum.includes("project_profile_hmac_sha256"));
    assert.match(envelope.privacyPolicy, /HMAC-SHA256/u);
    assert.match(envelope.privacyPolicy, /every nested object or array depth/u);
    assert.match(envelope.privacyPolicy, /toJSON/u);
    assert.match(envelope.privacyPolicy, /__proto__/u);
    assert.match(envelope.privacyPolicy, /cyclic input are rejected before any state mutation/u);
    assert.match(envelope.privacyPolicy, /accessors and toJSON are never executed/u);
    assert.match(envelope.pathPolicy?.profileSanitization, /reserved derived- namespace/u);
    assert.match(envelope.runIdPolicy, /All new schema-v2 writes must match \^meta-\[a-z0-9\]/u);
    assert.match(envelope.runIdPolicy, /Uppercase is accepted only.*schema-v1 historical record/u);
    assert.match(envelope.taskIdentityRecoveryPolicy, /requires the existing project\/profile key/u);
    assert.match(envelope.taskIdentityRecoveryPolicy, /restor(?:e|ing) the original key/u);
    assert.match(envelope.taskIdentityRecoveryPolicy, /destructive reset/u);
    assert.match(envelope.authorityAndRecoveryPolicy.lockOrder, /spine lock before the migration lock/u);
    assert.deepEqual(envelope.supportedReadSchemaVersions, [1, 2]);
    assert.deepEqual(envelope.supportedWriteSchemaVersions, [2]);
    assert.equal(envelope.authorityAndRecoveryPolicy.authority, "live_spine_state");

    for (const runtime of ["claude", "codex", "cursor", "openclaw"]) {
      assert.ok(
        envelope.runtimeAdapters?.[runtime],
        `runStatusEnvelope must document ${runtime} adapter behavior`,
      );
    }
  });

  test("task identity uses one protected project/profile HMAC key", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-task-identity-"));
    const spine = await import(
      `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?task=${Date.now()}`
    );
    try {
      const prompt = "yes";
      const identities = await Promise.all(
        Array.from({ length: 64 }, () =>
          spine.createProjectTaskIdentity(tempDir, prompt, { profile: "identity" }),
        ),
      );
      assert.equal(new Set(identities.map((item) => item.taskFingerprint)).size, 1);
      const identity = identities[0];
      assert.match(identity.taskFingerprint, /^hmac-sha256:[a-f0-9]{64}$/u);
      assert.equal(identity.taskIdentitySource, "project_profile_hmac_sha256");
      for (const candidate of ["yes", "no", "continue", "repair"]) {
        assert.notEqual(
          identity.taskFingerprint,
          `hmac-sha256:${createHash("sha256").update(candidate).digest("hex")}`,
        );
      }

      const state = spine.createInitialState({
        taskFingerprint: identity.taskFingerprint,
        taskIdentitySource: identity.taskIdentitySource,
        taskClassification: "meta_theory_auto",
      });
      state.profile = "identity";
      await spine.writeSpineState(tempDir, state);
      const serialized = await readFile(
        path.join(tempDir, ".meta-kim", "state", "identity", "spine", "spine-state.json"),
        "utf8",
      );
      assert.doesNotMatch(serialized, /\byes\b/u);
      assert.doesNotMatch(serialized, /"sha256:/u);

      const keyPath = path.join(
        tempDir,
        ".meta-kim",
        "state",
        "identity",
        "private",
        "task-identity-key.json",
      );
      const keyRecord = JSON.parse(await readFile(keyPath, "utf8"));
      assert.equal(Buffer.from(keyRecord.key, "base64").length, 32);
      if (process.platform !== "win32") {
        assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
      }

      await rm(keyPath, { force: true });
      const missingRequired = await spine.createProjectTaskIdentity(tempDir, prompt, {
        profile: "identity",
        requireExisting: true,
      });
      assert.equal(missingRequired.ready, false);
      assert.equal(missingRequired.status, "existing_key_missing");
      await assert.rejects(readFile(keyPath, "utf8"), { code: "ENOENT" });

      const corruptKeyBytes = "{corrupt-key";
      await writeFile(keyPath, corruptKeyBytes, "utf8");
      const corruptRequired = await spine.createProjectTaskIdentity(tempDir, prompt, {
        profile: "identity",
        requireExisting: true,
      });
      assert.equal(corruptRequired.ready, false);
      assert.equal(corruptRequired.status, "existing_key_invalid");
      assert.equal(await readFile(keyPath, "utf8"), corruptKeyBytes);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("task identity lock survives cross-process exclusive-create storms", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-task-identity-process-"));
    const moduleUrl = pathToFileURL(path.join(
      __dirname,
      "..",
      "..",
      "canonical",
      "runtime-assets",
      "shared",
      "hooks",
      "spine-state.mjs",
    )).href;
    try {
      const rounds = process.platform === "win32" ? 3 : 1;
      const fanout = process.platform === "win32" ? 16 : 8;
      const identities = [];
      for (let round = 0; round < rounds; round += 1) {
        identities.push(...await Promise.all(
          Array.from({ length: fanout }, () =>
            createTaskIdentityInChild(moduleUrl, tempDir, "process-identity", "yes"),
          ),
        ));
      }
      assert.equal(new Set(identities.map((item) => item.taskFingerprint)).size, 1);
      assert.ok(identities.every(
        (item) => item.taskIdentitySource === "project_profile_hmac_sha256",
      ));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("writers reject traversal and non-Meta_Kim run IDs before path construction", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-run-id-"));
    try {
      const spine = await import(
        `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?runid=${Date.now()}`
      );
      for (const runId of [
        "../escape",
        "meta-../escape",
        "meta-a/b",
        "not-meta-prefixed",
        `meta-${"a".repeat(117)}`,
      ]) {
        const state = { ...spine.createInitialState(), runId };
        await assert.rejects(
          spine.writeSpineState(tempDir, state),
          /Invalid Meta_Kim runId/u,
        );
        assert.throws(
          () => spine.createMetaRunStatusEnvelope(state),
          /Invalid Meta_Kim runId/u,
        );
      }
      await assert.rejects(
        readFile(path.join(tempDir, ".meta-kim", "state", "escape", "status.json")),
        { code: "ENOENT" },
      );
      const generated = Array.from({ length: 5000 }, () =>
        spine.createInitialState().runId,
      );
      assert.equal(new Set(generated).size, generated.length);
      assert.ok(generated.every((runId) => /^meta-.+-[a-f0-9]{16}$/u.test(runId)));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("new uppercase run IDs are rejected and derived profile namespaces cannot alias", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-run-id-case-"));
    try {
      const spine = await import(
        `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?runidcase=${Date.now()}`
      );
      const upper = {
        ...spine.createInitialState({ taskClassification: "case_regression" }),
        profile: "case-runid",
        runId: "meta-Case",
      };
      assert.throws(
        () => spine.createMetaRunStatusEnvelope(upper),
        /Invalid Meta_Kim runId/u,
      );
      await assert.rejects(spine.writeSpineState(tempDir, upper), /Invalid Meta_Kim runId/u);
      await assert.rejects(spine.activateSpineState(tempDir, upper), /Invalid Meta_Kim runId/u);
      await assert.rejects(spine.writeMetaRunStatus(tempDir, upper), /Invalid Meta_Kim runId/u);
      await assert.rejects(
        readFile(path.join(tempDir, ".meta-kim", "state", "case-runid", "spine", "spine-state.json")),
        { code: "ENOENT" },
      );

      const derived = spine.sanitizeStateProfile("Case-RunId");
      const sameDerivedAgain = spine.sanitizeStateProfile("Case-RunId");
      const caseDistinct = spine.sanitizeStateProfile("case-runid");
      const reservedDirectName = spine.sanitizeStateProfile(derived);
      assert.match(derived, /^derived-[a-z0-9._-]+-[a-f0-9]{12}$/u);
      assert.equal(sameDerivedAgain, derived);
      assert.equal(caseDistinct, "case-runid");
      assert.notEqual(derived, caseDistinct);
      assert.notEqual(reservedDirectName, derived);
      assert.match(reservedDirectName, /^derived-derived-/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("spine-state writes active-run and per-run status files", async () => {
    // Isolate language-resolution env vars: resolveOutputLanguage() falls back
    // to process.env.LANG / META_KIM_OUTPUT_LANGUAGE / LC_ALL / LANGUAGE when no
    // higher-priority candidate is present. Host shells (e.g. zh_CN.UTF-8)
    // leak LANG into the test process and flip languageResolution.source from
    // "not_resolved" to "environment", breaking the assertions below. Save +
    // clear before the test, restore in finally so other tests are unaffected.
    const savedLang = {
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      LANGUAGE: process.env.LANGUAGE,
      META_KIM_OUTPUT_LANGUAGE: process.env.META_KIM_OUTPUT_LANGUAGE,
    };
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LANGUAGE;
    delete process.env.META_KIM_OUTPUT_LANGUAGE;

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-status-"));
    try {
      const spine = await import(
        `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?test=${Date.now()}`
      );

      let state = spine.createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "skill_activation_auto",
      });
      await spine.writeSpineState(tempDir, state);

      const activePath = path.join(
        tempDir,
        ".meta-kim",
        "state",
        "default",
        "active-run.json",
      );
      let active = JSON.parse(await readFile(activePath, "utf8"));

      assert.equal(active.active, true);
      assert.equal(active.lifecycleStatus, "active");
      assert.equal(active.currentStage, "Critical");
      assert.equal(active.stageIndex, 1);
      assert.equal(active.stageTotal, 8);
      assert.equal(active.percent, 12);
      assert.equal(active.authorityMode, "managed_runtime_spine");
      assert.equal(active.driverMode, "managed");
      assert.equal(active.hookGateMode, "block");
      assert.equal(active.publicReadyAuthority, false);
      assert.equal(active.publicReadyBoundary.status, "not_public_ready_authority");
      assert.equal(active.deactivatedAt, null);
      assert.equal(active.deactivationReason, null);
      assert.equal(active.continuationBoundary.status, "active_run");
      assert.equal(active.resolvedOutputLanguage, "undetermined");
      assert.equal(active.languageResolution.source, "not_resolved");
      assert.equal(active.stagePurposeKey, "critical");
      assert.equal(active.taskFingerprint, null);
      assert.equal(active.taskIdentitySource, "not_available");
      assert.equal("task" in active, false);
      assert.equal(active.publicSurface.primaryDisplay, "conversation_notice");
      assert.equal(active.publicSurface.popupRequired, false);
      assert.ok(active.runId.startsWith("meta-"));

      const perRunPath = path.join(
        tempDir,
        ".meta-kim",
        "state",
        "default",
        "runs",
        active.runId,
        "status.json",
      );
      const perRun = JSON.parse(await readFile(perRunPath, "utf8"));
      assert.equal(perRun.runId, active.runId);

      state = spine.advanceStage(state, "fetch");
      await spine.writeSpineState(tempDir, state);
      active = JSON.parse(await readFile(activePath, "utf8"));

      assert.equal(active.currentStage, "Fetch");
      assert.equal(active.stageIndex, 2);
      assert.equal(active.percent, 25);
      assert.deepEqual(active.completed, ["Critical"]);
      assert.equal(active.next, "Thinking");
      assert.equal(active.stagePurposeKey, "fetch");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(savedLang)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("Meta-Review keeps its canonical stage key in envelopes and status", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-meta-review-status-"));
    const spine = await import(
      `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?metaReview=${Date.now()}`
    );
    try {
      const state = spine.createInitialState({ taskClassification: "meta_review_status" });
      for (const stage of ["critical", "fetch", "thinking", "execution", "review"]) {
        state.stages[stage] = { status: "completed", completedAt: new Date().toISOString() };
      }
      state.currentStage = "meta-review";
      state.stages["meta-review"] = { status: "in_progress", completedAt: null };
      await spine.writeSpineState(tempDir, state);

      const status = JSON.parse(await readFile(path.join(
        tempDir,
        ".meta-kim",
        "state",
        "default",
        "active-run.json",
      ), "utf8"));
      for (const envelope of [
        status,
        spine.createMetaRunStatusEnvelope({ ...state, currentStage: "meta_review" }),
      ]) {
        assert.equal(envelope.currentStageKey, "meta-review");
        assert.equal(envelope.currentStage, "Meta-Review");
        assert.equal(envelope.stageIndex, 6);
        assert.equal(envelope.percent, 75);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("one-time reconciliation archives only non-authoritative valid active history", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-status-reconcile-"));
    const previousProfile = process.env.META_KIM_PROFILE;
    try {
      process.env.META_KIM_PROFILE = "alpha";
      const spine = await import(
        `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?reconcile=${Date.now()}`
      );
      const profileRoot = path.join(tempDir, ".meta-kim", "state", "alpha", "runs");
      const authorityState = {
        ...spine.createInitialState({ taskClassification: "migration_authority" }),
        runId: "meta-authoritative",
      };
      await spine.writeSpineState(tempDir, authorityState);
      const records = {
        "meta-authoritative": createLegacyEnvelope(spine, "meta-authoritative"),
        "meta-archived": {
          ...createLegacyEnvelope(spine, "meta-archived", { withoutAuthority: true }),
          task: "legacy raw prompt must be removed",
        },
        "meta-terminal": createLegacyEnvelope(spine, "meta-terminal", { active: false }),
        "meta-LegacyUpper": {
          ...createLegacyEnvelope(spine, "meta-legacyupper", {
            withoutAuthority: true,
          }),
          runId: "meta-LegacyUpper",
        },
        "meta-V2UpperPreserved": {
          ...createLegacyEnvelope(spine, "meta-v2upperpreserved", {
            withoutAuthority: true,
          }),
          schemaVersion: 2,
          runId: "meta-V2UpperPreserved",
        },
        "meta-unknown": { runId: "meta-different-directory-id", active: true },
      };
      for (const [runId, value] of Object.entries(records)) {
        const dir = path.join(profileRoot, runId);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "status.json"), JSON.stringify(value), "utf8");
      }
      const malformedDir = path.join(profileRoot, "meta-malformed");
      await mkdir(malformedDir, { recursive: true });
      await writeFile(path.join(malformedDir, "status.json"), "{broken", "utf8");

      const otherProfilePath = path.join(
        tempDir,
        ".meta-kim",
        "state",
        "beta",
        "runs",
        "meta-other",
        "status.json",
      );
      await mkdir(path.dirname(otherProfilePath), { recursive: true });
      await writeFile(
        otherProfilePath,
        JSON.stringify({ runId: "meta-other", active: true }),
        "utf8",
      );

      const [first, concurrent] = await Promise.all([
        spine.reconcileLegacyRunStatuses(tempDir, {
          profile: "alpha",
        }),
        spine.reconcileLegacyRunStatuses(tempDir, {
          profile: "alpha",
        }),
      ]);
      const report = first.alreadyCompleted ? concurrent : first;
      assert.equal(report.scannedRecords, 7);
      assert.equal(report.authoritativeActivePreserved, 1);
      assert.equal(report.terminalPreserved, 1);
      assert.equal(report.archived, 2);
      assert.equal(report.malformedPreserved, 1);
      assert.equal(report.unknownPreserved, 2);

      const archived = JSON.parse(
        await readFile(path.join(profileRoot, "meta-archived", "status.json"), "utf8"),
      );
      assert.equal(archived.schemaVersion, 2);
      assert.equal(archived.active, false);
      assert.equal(archived.lifecycleStatus, "archived_legacy");
      assert.equal(archived.deactivationReason, "legacy_reconciled");
      assert.equal(archived.taskIdentitySource, "unrecoverable_legacy");
      assert.equal(archived.taskFingerprint, null);
      assert.equal("task" in archived, false);
      assert.doesNotMatch(JSON.stringify(archived), /legacy raw prompt/);
      const archivedUpper = JSON.parse(
        await readFile(path.join(profileRoot, "meta-LegacyUpper", "status.json"), "utf8"),
      );
      assert.equal(archivedUpper.schemaVersion, 2);
      assert.equal(archivedUpper.runId, "meta-LegacyUpper");
      assert.equal(archivedUpper.lifecycleStatus, "archived_legacy");
      assert.deepEqual(
        JSON.parse(await readFile(
          path.join(profileRoot, "meta-V2UpperPreserved", "status.json"),
          "utf8",
        )),
        records["meta-V2UpperPreserved"],
      );
      assert.deepEqual(
        JSON.parse(await readFile(path.join(profileRoot, "meta-terminal", "status.json"), "utf8")),
        records["meta-terminal"],
      );
      assert.equal(await readFile(path.join(malformedDir, "status.json"), "utf8"), "{broken");
      assert.deepEqual(JSON.parse(await readFile(otherProfilePath, "utf8")), {
        runId: "meta-other",
        active: true,
      });

      const markerPath = path.join(
        tempDir,
        ".meta-kim",
        "state",
        "alpha",
        "migrations",
        "run-status-lifecycle-v1.json",
      );
      const markerBefore = await readFile(markerPath, "utf8");
      const marker = JSON.parse(markerBefore);
      assert.equal(marker.schemaVersion, 1);
      assert.equal(marker.authoritativeRunId, authorityState.runId);
      assert.ok(Number.isFinite(Date.parse(marker.completedAt)));
      for (const field of [
        "scannedRecords",
        "authoritativeActivePreserved",
        "terminalPreserved",
        "archived",
        "malformedPreserved",
        "unknownPreserved",
        "unsafePreserved",
      ]) {
        assert.ok(Number.isInteger(marker[field]) && marker[field] >= 0, field);
      }
      const repeat = await spine.reconcileLegacyRunStatuses(tempDir, {
        profile: "alpha",
      });
      assert.equal(repeat.alreadyCompleted, true);
      assert.equal(await readFile(markerPath, "utf8"), markerBefore);

      const nextAuthority = {
        ...spine.createInitialState({ taskClassification: "post_migration_authority" }),
        runId: "meta-post-migration-authority",
      };
      const nextActivation = await spine.activateSpineState(tempDir, nextAuthority, {
        replaceActive: true,
        expectedRunId: authorityState.runId,
      });
      assert.equal(nextActivation.activated, true);
      assert.equal(nextActivation.migration.alreadyCompleted, true);
      const lateStatusPath = path.join(
        profileRoot,
        "meta-late-legacy",
        "status.json",
      );
      await mkdir(path.dirname(lateStatusPath), { recursive: true });
      const lateRecord = createLegacyEnvelope(spine, "meta-late-legacy");
      await writeFile(lateStatusPath, JSON.stringify(lateRecord), "utf8");
      const afterNewAuthority = await spine.reconcileLegacyRunStatuses(tempDir, {
        profile: "alpha",
      });
      assert.equal(afterNewAuthority.alreadyCompleted, true);
      assert.equal(await readFile(lateStatusPath, "utf8"), JSON.stringify(lateRecord));
      assert.equal(await readFile(markerPath, "utf8"), markerBefore);
    } finally {
      if (previousProfile === undefined) delete process.env.META_KIM_PROFILE;
      else process.env.META_KIM_PROFILE = previousProfile;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("reconciliation requires proven authority and preserves an invalid marker", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-status-authority-"));
    try {
      const spine = await import(
        `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?authority=${Date.now()}`
      );
      const statusPath = path.join(
        tempDir,
        ".meta-kim",
        "state",
        "default",
        "runs",
        "meta-historical",
        "status.json",
      );
      await mkdir(path.dirname(statusPath), { recursive: true });
      const historicalRecord = createLegacyEnvelope(spine, "meta-historical", {
        withoutAuthority: true,
      });
      const historical = JSON.stringify(historicalRecord);
      await writeFile(statusPath, historical, "utf8");

      const unproven = await spine.reconcileLegacyRunStatuses(tempDir, {
        profile: "default",
      });
      assert.equal(unproven.status, "authority_not_proven");
      assert.equal(await readFile(statusPath, "utf8"), historical);

      const authority = {
        ...spine.createInitialState({ taskClassification: "authority_test" }),
        runId: "meta-authority-test",
      };
      await spine.writeSpineState(tempDir, authority);
      const markerPath = path.join(
        tempDir,
        ".meta-kim",
        "state",
        "default",
        "migrations",
        "run-status-lifecycle-v1.json",
      );
      await mkdir(path.dirname(markerPath), { recursive: true });
      const invalidPrimaryBytes = '{"completed":true,"unknown":"preserve exactly"}';
      await writeFile(markerPath, invalidPrimaryBytes, "utf8");
      const invalidMarker = await spine.reconcileLegacyRunStatuses(tempDir, {
        profile: "default",
      });
      assert.equal(invalidMarker.invalidMarkerPreserved, true);
      assert.equal(invalidMarker.archived, 1);
      assert.equal(invalidMarker.completionSource, "managed_sidecar");
      assert.equal(await readFile(markerPath, "utf8"), invalidPrimaryBytes);
      const archived = JSON.parse(await readFile(statusPath, "utf8"));
      assert.equal(archived.lifecycleStatus, "archived_legacy");

      const sidecarPath = path.join(
        tempDir,
        ".meta-kim",
        "state",
        "default",
        "migrations",
        "run-status-lifecycle-v1.managed-completion.json",
      );
      const sidecarBefore = await readFile(sidecarPath, "utf8");
      const sidecar = JSON.parse(sidecarBefore);
      assert.equal(sidecar.completed, true);
      assert.equal(sidecar.archived, 1);

      const lateStatusPath = path.join(
        tempDir,
        ".meta-kim",
        "state",
        "default",
        "runs",
        "meta-late-after-sidecar",
        "status.json",
      );
      await mkdir(path.dirname(lateStatusPath), { recursive: true });
      const lateRecord = createLegacyEnvelope(spine, "meta-late-after-sidecar", {
        withoutAuthority: true,
      });
      const lateBytes = JSON.stringify(lateRecord);
      await writeFile(lateStatusPath, lateBytes, "utf8");
      const repeated = await spine.reconcileLegacyRunStatuses(tempDir, {
        profile: "default",
      });
      assert.equal(repeated.alreadyCompleted, true);
      assert.equal(repeated.completionSource, "managed_sidecar");
      assert.equal(await readFile(markerPath, "utf8"), invalidPrimaryBytes);
      assert.equal(await readFile(sidecarPath, "utf8"), sidecarBefore);
      assert.equal(await readFile(lateStatusPath, "utf8"), lateBytes);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("an invalid migration completion sidecar fails closed without mutation", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-status-sidecar-invalid-"));
    try {
      const spine = await import(
        `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?sidecarInvalid=${Date.now()}`
      );
      const authority = {
        ...spine.createInitialState({ taskClassification: "sidecar_invalid_authority" }),
        runId: "meta-sidecar-invalid-authority",
      };
      await spine.writeSpineState(tempDir, authority);
      const migrationDir = path.join(
        tempDir,
        ".meta-kim",
        "state",
        "default",
        "migrations",
      );
      await mkdir(migrationDir, { recursive: true });
      const primaryPath = path.join(migrationDir, "run-status-lifecycle-v1.json");
      const sidecarPath = path.join(
        migrationDir,
        "run-status-lifecycle-v1.managed-completion.json",
      );
      const primaryBytes = '{"completed":true,"unknown":"primary"}';
      const sidecarBytes = "{malformed";
      await writeFile(primaryPath, primaryBytes, "utf8");
      await writeFile(sidecarPath, sidecarBytes, "utf8");
      const legacyPath = path.join(
        tempDir,
        ".meta-kim",
        "state",
        "default",
        "runs",
        "meta-sidecar-blocked-legacy",
        "status.json",
      );
      await mkdir(path.dirname(legacyPath), { recursive: true });
      const legacyBytes = JSON.stringify(
        createLegacyEnvelope(spine, "meta-sidecar-blocked-legacy", {
          withoutAuthority: true,
        }),
      );
      await writeFile(legacyPath, legacyBytes, "utf8");

      const blocked = await spine.reconcileLegacyRunStatuses(tempDir, {
        profile: "default",
      });
      assert.equal(blocked.completed, false);
      assert.equal(blocked.status, "invalid_completion_sidecar");
      assert.equal(blocked.invalidCompletionSidecarPreserved, true);
      assert.equal(await readFile(primaryPath, "utf8"), primaryBytes);
      assert.equal(await readFile(sidecarPath, "utf8"), sidecarBytes);
      assert.equal(await readFile(legacyPath, "utf8"), legacyBytes);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("spine-to-migration lock order prevents a newer run from being archived", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-migration-lock-order-"));
    try {
      const spine = await import(
        `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?lockOrder=${Date.now()}`
      );
      const { withFileLock } = await import(
        `../../canonical/runtime-assets/shared/hooks/spine-state-utils.mjs?lockOrder=${Date.now()}`
      );
      const runA = {
        ...spine.createInitialState({ taskClassification: "lock_order_a" }),
        runId: "meta-lock-order-a",
      };
      await spine.writeSpineState(tempDir, runA);
      const legacyPath = path.join(
        tempDir,
        ".meta-kim",
        "state",
        "default",
        "runs",
        "meta-lock-order-legacy",
        "status.json",
      );
      await mkdir(path.dirname(legacyPath), { recursive: true });
      await writeFile(
        legacyPath,
        JSON.stringify(createLegacyEnvelope(spine, "meta-lock-order-legacy")),
        "utf8",
      );

      const migrationLock = path.join(
        tempDir,
        ".meta-kim",
        "state",
        "default",
        "migrations",
        "run-status-lifecycle-v1.json.lock",
      );
      const spineLock = path.join(
        tempDir,
        ".meta-kim",
        "state",
        "default",
        "spine",
        "spine-state.json.lock",
      );
      let releaseMigration;
      let migrationHeld;
      const held = new Promise((resolve) => { migrationHeld = resolve; });
      const release = new Promise((resolve) => { releaseMigration = resolve; });
      const holder = withFileLock(migrationLock, async () => {
        migrationHeld();
        await release;
      });
      await held;

      const reconciliation = spine.reconcileLegacyRunStatuses(tempDir, { profile: "default" });
      await waitForFile(spineLock);
      const runB = {
        ...spine.createInitialState({ taskClassification: "lock_order_b" }),
        runId: "meta-lock-order-b",
      };
      const activation = spine.activateSpineState(tempDir, runB, {
        replaceActive: true,
        expectedRunId: runA.runId,
      });
      releaseMigration();

      const [report, activated] = await Promise.all([reconciliation, activation, holder]);
      assert.equal(report.archived, 1);
      assert.equal(activated.activated, true);
      assert.equal((await spine.readSpineState(tempDir)).runId, runB.runId);
      const runBStatus = JSON.parse(await readFile(path.join(
        tempDir,
        ".meta-kim",
        "state",
        "default",
        "runs",
        runB.runId,
        "status.json",
      ), "utf8"));
      assert.equal(runBStatus.lifecycleStatus, "active");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("strict authority leaves schema-less, unknown-schema, and invalid lifecycle records untouched", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-strict-authority-"));
    try {
      const spine = await import(
        `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?strictAuthority=${Date.now()}`
      );
      const authority = {
        ...spine.createInitialState({ taskClassification: "strict_authority" }),
        runId: "meta-strict-authority",
      };
      await spine.writeSpineState(tempDir, authority);
      const records = {
        "meta-strong-v1": createLegacyEnvelope(spine, "meta-strong-v1", {
          withoutAuthority: true,
        }),
        "meta-schema-less": { runId: "meta-schema-less", active: true },
        "meta-unknown-schema": {
          ...createLegacyEnvelope(spine, "meta-unknown-schema"),
          schemaVersion: 99,
        },
        "meta-invalid-lifecycle": {
          ...spine.createMetaRunStatusEnvelope({
            ...spine.createInitialState(),
            runId: "meta-invalid-lifecycle",
          }),
          lifecycleStatus: "session_stopped",
          deactivationReason: "session_stop",
        },
        "meta-invalid-v1-active-stop": {
          ...createLegacyEnvelope(spine, "meta-invalid-v1-active-stop", {
            withoutAuthority: true,
          }),
          deactivationReason: "session_stop",
          deactivatedAt: "2026-06-20T18:27:05.423Z",
        },
        "meta-invalid-v1-active-time": {
          ...createLegacyEnvelope(spine, "meta-invalid-v1-active-time", {
            withoutAuthority: true,
          }),
          deactivatedAt: "2026-06-20T18:27:05.423Z",
        },
      };
      const oldestInactive = createLegacyEnvelope(spine, "meta-oldest-v1-inactive", {
        active: false,
        withoutAuthority: true,
      });
      delete oldestInactive.deactivationReason;
      delete oldestInactive.deactivatedAt;
      records["meta-oldest-v1-inactive"] = oldestInactive;
      const originals = new Map();
      for (const [runId, record] of Object.entries(records)) {
        const statusPath = path.join(
          tempDir,
          ".meta-kim",
          "state",
          "default",
          "runs",
          runId,
          "status.json",
        );
        await mkdir(path.dirname(statusPath), { recursive: true });
        const serialized = JSON.stringify(record);
        originals.set(runId, serialized);
        await writeFile(statusPath, serialized, "utf8");
      }
      const report = await spine.reconcileLegacyRunStatuses(tempDir, { profile: "default" });
      assert.equal(report.archived, 1);
      assert.equal(report.terminalPreserved, 1);
      assert.equal(report.unknownPreserved, 5);
      const archived = JSON.parse(await readFile(path.join(
        tempDir,
        ".meta-kim",
        "state",
        "default",
        "runs",
        "meta-strong-v1",
        "status.json",
      ), "utf8"));
      assert.equal(archived.lifecycleStatus, "archived_legacy");
      for (const runId of [
        "meta-schema-less",
        "meta-unknown-schema",
        "meta-invalid-lifecycle",
        "meta-invalid-v1-active-stop",
        "meta-invalid-v1-active-time",
        "meta-oldest-v1-inactive",
      ]) {
        assert.equal(await readFile(path.join(
          tempDir,
          ".meta-kim",
          "state",
          "default",
          "runs",
          runId,
          "status.json",
        ), "utf8"), originals.get(runId));
      }

      const malformedState = {
        ...authority,
        currentStage: "FETCH",
        stages: { critical: { status: "in_progress" } },
      };
      await writeFile(
        path.join(tempDir, ".meta-kim", "state", "default", "spine", "spine-state.json"),
        JSON.stringify(malformedState),
        "utf8",
      );
      const unproven = await spine.reconcileLegacyRunStatuses(tempDir, { profile: "default" });
      assert.equal(unproven.status, "authority_not_proven");
      await assert.rejects(
        spine.writeSpineState(tempDir, malformedState),
        /Invalid Meta_Kim spine state schema/u,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("state writers and migration refuse symlink or junction escapes", async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-status-links-"));
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-status-outside-"));
    try {
      const spine = await import(
        `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?links=${Date.now()}`
      );
      const stateRoot = path.join(tempDir, ".meta-kim", "state");
      await mkdir(stateRoot, { recursive: true });
      const profileLink = path.join(stateRoot, "default");
      if (!(await createDirectoryLink(outsideDir, profileLink))) {
        t.skip("directory links are unavailable on this host");
        return;
      }
      const linkedState = {
        ...spine.createInitialState({ taskClassification: "link_test" }),
        runId: "meta-linked-profile",
      };
      await assert.rejects(
        spine.writeSpineState(tempDir, linkedState),
        /Unsafe|symlink|reparse|Refusing/iu,
      );
      await assert.rejects(readFile(path.join(outsideDir, "spine", "spine-state.json")), {
        code: "ENOENT",
      });

      await rm(profileLink, { recursive: true, force: true });
      const authority = {
        ...spine.createInitialState({ taskClassification: "link_authority" }),
        runId: "meta-link-authority",
      };
      await spine.writeSpineState(tempDir, authority);
      const escapedRun = path.join(stateRoot, "default", "runs", "meta-escaped-run");
      await createDirectoryLink(outsideDir, escapedRun);
      await assert.rejects(
        spine.writeMetaRunStatus(tempDir, {
          ...authority,
          runId: "meta-escaped-run",
        }),
        /Unsafe|symlink|reparse|Refusing/iu,
      );
      const report = await spine.reconcileLegacyRunStatuses(tempDir, {
        profile: "default",
      });
      assert.ok(report.unsafePreserved >= 1);
      await assert.rejects(readFile(path.join(outsideDir, "status.json")), {
        code: "ENOENT",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("CAS prevents stale refresh, write, Stop, and delete from touching a newer run", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-status-cas-"));
    try {
      const spine = await import(
        `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?cas=${Date.now()}`
      );
      const oldState = {
        ...spine.createInitialState({ taskClassification: "cas_old" }),
        runId: "meta-cas-old",
      };
      await spine.writeSpineState(tempDir, oldState);
      const newState = {
        ...spine.createInitialState({ taskClassification: "cas_new" }),
        runId: "meta-cas-new",
      };
      const activated = await spine.activateSpineState(tempDir, newState, {
        replaceActive: true,
        expectedRunId: oldState.runId,
      });
      assert.equal(activated.activated, true);

      const staleRefresh = await spine.activateSpineState(tempDir, oldState, {
        refreshExisting: true,
        expectedRunId: oldState.runId,
      });
      assert.equal(staleRefresh.reason, "refresh_authority_changed");
      const staleWrite = await spine.writeSpineState(tempDir, oldState, {
        expectedRunId: oldState.runId,
      });
      assert.equal(staleWrite.reason, "expected_run_changed");
      const staleStop = await spine.terminalizeSpineState(tempDir, {
        expectedRunId: oldState.runId,
        reason: "evolution_completed",
        removeStateFile: true,
      });
      assert.equal(staleStop.reason, "expected_run_changed");
      assert.equal((await spine.readSpineState(tempDir)).runId, newState.runId);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("refreshExisting never activates missing, inactive, deleted, or different authority", async () => {
    const spine = await import(
      `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?refreshGuards=${Date.now()}`
    );

    const missingDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-refresh-missing-"));
    try {
      const candidate = spine.createInitialState({ taskClassification: "refresh_missing" });
      const missing = await spine.activateSpineState(missingDir, candidate, {
        refreshExisting: true,
        expectedRunId: candidate.runId,
      });
      assert.equal(missing.reason, "refresh_authority_missing");
      assert.equal(await spine.readSpineStateIncludingInactive(missingDir), null);
    } finally {
      await rm(missingDir, { recursive: true, force: true });
    }

    for (const evolutionCompleted of [false, true]) {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-refresh-terminal-"));
      try {
        const state = spine.createInitialState({ taskClassification: "refresh_terminal" });
        if (evolutionCompleted) {
          state.currentStage = "evolution";
          state.stages.evolution = { status: "completed", completedAt: new Date().toISOString() };
        }
        await spine.writeSpineState(tempDir, state);
        await spine.terminalizeSpineState(tempDir, {
          expectedRunId: state.runId,
          reason: evolutionCompleted ? "evolution_completed" : "session_stop",
          removeStateFile: evolutionCompleted,
        });
        const refreshed = await spine.activateSpineState(tempDir, state, {
          refreshExisting: true,
          expectedRunId: state.runId,
        });
        assert.equal(
          refreshed.reason,
          evolutionCompleted ? "refresh_authority_missing" : "refresh_authority_inactive",
        );
        assert.equal(await spine.readSpineState(tempDir), null);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  test("terminal repair preserves the first reason and completes interrupted Evolution deletion", async () => {
    const spine = await import(
      `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?terminalRepair=${Date.now()}`
    );
    for (const originalReason of ["session_stop", "evolution_completed"]) {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-terminal-repair-"));
      try {
        const state = spine.createInitialState({ taskClassification: "terminal_repair" });
        if (originalReason === "evolution_completed") {
          state.currentStage = "evolution";
          state.stages.evolution = { status: "completed", completedAt: new Date().toISOString() };
        }
        await spine.writeSpineState(tempDir, state);
        await assert.rejects(
          spine.terminalizeSpineState(tempDir, {
            expectedRunId: state.runId,
            reason: originalReason,
            removeStateFile: originalReason === "evolution_completed",
            interruptAfter: "spine",
          }),
          /Injected interruption/u,
        );

        const repaired = await spine.terminalizeSpineState(tempDir, {
          expectedRunId: state.runId,
          reason: originalReason === "session_stop" ? "evolution_completed" : "session_stop",
          removeStateFile: true,
        });
        assert.equal(repaired.repaired, true);
        assert.equal(repaired.reason, originalReason);
        assert.equal(repaired.removed, originalReason === "evolution_completed");
        const status = JSON.parse(await readFile(path.join(
          tempDir,
          ".meta-kim",
          "state",
          "default",
          "runs",
          state.runId,
          "status.json",
        ), "utf8"));
        assert.equal(status.deactivationReason, originalReason);
        assert.equal(
          status.lifecycleStatus,
          originalReason === "session_stop" ? "session_stopped" : "evolution_completed",
        );
        const statePath = path.join(
          tempDir,
          ".meta-kim",
          "state",
          "default",
          "spine",
          "spine-state.json",
        );
        if (originalReason === "evolution_completed") {
          await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
        } else {
          assert.equal(JSON.parse(await readFile(statePath, "utf8")).active, false);
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  test("activation repairs an interrupted inactive projection before publishing a new run", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-terminal-before-activate-"));
    try {
      const spine = await import(
        `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?terminalBeforeActivate=${Date.now()}`
      );
      const stopped = spine.createInitialState({ taskClassification: "stopped_before_new" });
      await spine.writeSpineState(tempDir, stopped);
      await assert.rejects(
        spine.terminalizeSpineState(tempDir, {
          expectedRunId: stopped.runId,
          reason: "session_stop",
          interruptAfter: "spine",
        }),
        /Injected interruption/u,
      );
      const next = spine.createInitialState({ taskClassification: "next_after_stopped" });
      const activated = await spine.activateSpineState(tempDir, next);
      assert.equal(activated.activated, true);
      const prior = JSON.parse(await readFile(path.join(
        tempDir,
        ".meta-kim",
        "state",
        "default",
        "runs",
        stopped.runId,
        "status.json",
      ), "utf8"));
      assert.equal(prior.lifecycleStatus, "session_stopped");
      assert.equal(prior.deactivationReason, "session_stop");
      assert.notEqual(prior.lifecycleStatus, "archived_legacy");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("interrupted projections read truth from spine and same-run refresh repairs them", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-status-interrupt-"));
    try {
      const spine = await import(
        `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?interrupt=${Date.now()}`
      );
      const oldState = {
        ...spine.createInitialState({ taskClassification: "interrupt_old" }),
        runId: "meta-interrupt-old",
      };
      await spine.writeSpineState(tempDir, oldState);
      const newState = {
        ...spine.createInitialState({ taskClassification: "interrupt_new" }),
        runId: "meta-interrupt-new",
        task: "raw prompt injected at boundary",
      };
      await assert.rejects(
        spine.activateSpineState(tempDir, newState, {
          replaceActive: true,
          expectedRunId: oldState.runId,
          interruptAfter: "spine",
        }),
        /Injected interruption/u,
      );

      const truthful = await spine.readMetaRunStatus(tempDir, "default");
      assert.equal(truthful.runId, newState.runId);
      assert.equal(truthful.active, true);
      assert.equal("task" in truthful, false);
      const projectedBefore = JSON.parse(
        await readFile(
          path.join(tempDir, ".meta-kim", "state", "default", "active-run.json"),
          "utf8",
        ),
      );
      assert.equal(projectedBefore.runId, oldState.runId);
      assert.equal(projectedBefore.active, false);

      const refreshed = await spine.activateSpineState(tempDir, newState, {
        refreshExisting: true,
        expectedRunId: newState.runId,
      });
      assert.equal(refreshed.reason, "same_run_refreshed");
      const projectedAfter = JSON.parse(
        await readFile(
          path.join(tempDir, ".meta-kim", "state", "default", "active-run.json"),
          "utf8",
        ),
      );
      assert.equal(projectedAfter.runId, newState.runId);
      assert.equal(projectedAfter.active, true);
      assert.doesNotMatch(JSON.stringify(projectedAfter), /raw prompt injected/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("Stop terminalizes unfinished and Evolution-complete runs before cleanup", async () => {
    const spine = await import(
      `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?stop=${Date.now()}`
    );
    const stopScript = path.join(
      __dirname,
      "..",
      "..",
      "canonical",
      "runtime-assets",
      "shared",
      "hooks",
      "stop-spine-cleanup.mjs",
    );

    for (const evolutionCompleted of [false, true]) {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-status-stop-"));
      try {
        const state = spine.createInitialState({ taskClassification: "stop_test" });
        if (evolutionCompleted) {
          state.currentStage = "evolution";
          state.stages.evolution = { status: "completed", completedAt: new Date().toISOString() };
        }
        await spine.writeSpineState(tempDir, state);
        const result = spawnSync(process.execPath, [stopScript], {
          cwd: tempDir,
          input: "{}",
          encoding: "utf8",
        });
        assert.equal(result.status, 0, result.stderr);

        const statusPath = path.join(
          tempDir,
          ".meta-kim",
          "state",
          "default",
          "runs",
          state.runId,
          "status.json",
        );
        const status = JSON.parse(await readFile(statusPath, "utf8"));
        assert.equal(status.active, false);
        assert.equal(
          status.lifecycleStatus,
          evolutionCompleted ? "evolution_completed" : "session_stopped",
        );
        assert.equal(
          status.deactivationReason,
          evolutionCompleted ? "evolution_completed" : "session_stop",
        );
        const spinePath = path.join(
          tempDir,
          ".meta-kim",
          "state",
          "default",
          "spine",
          "spine-state.json",
        );
        if (evolutionCompleted) {
          await assert.rejects(readFile(spinePath, "utf8"), { code: "ENOENT" });
        } else {
          const stoppedState = JSON.parse(await readFile(spinePath, "utf8"));
          assert.equal(stoppedState.active, false);
          assert.equal(stoppedState.deactivationReason, "session_stop");
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  test("hook-observed advisory status is not managed runtime or public-ready authority", async () => {
    const spine = await import(
      `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?observed=${Date.now()}`
    );
    const envelope = spine.createMetaRunStatusEnvelope({
      active: true,
      runId: "meta-observed-test",
      currentStage: "fetch",
      stageRuntimeControl: {
        activationMode: "hook_observed",
        driverMode: "hook_observed",
        hookGateMode: "advisory",
      },
      stages: {
        critical: { status: "completed" },
        fetch: { status: "in_progress" },
      },
    });

    assert.equal(envelope.currentStage, "Fetch");
    assert.equal(envelope.authorityMode, "hook_observed_advisory");
    assert.equal(envelope.driverMode, "hook_observed");
    assert.equal(envelope.hookGateMode, "advisory");
    assert.equal(envelope.publicReadyAuthority, false);
    assert.match(envelope.publicReadyBoundary.reason, /Public-ready requires/);
  });

  test("inactive session-stop status exposes continuation boundary", async () => {
    const spine = await import(
      `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?inactive=${Date.now()}`
    );
    const envelope = spine.createMetaRunStatusEnvelope({
      active: false,
      runId: "meta-stopped-test",
      currentStage: "critical",
      deactivatedAt: "2026-06-20T18:27:05.423Z",
      deactivationReason: "session_stop",
      stages: {
        critical: { status: "in_progress" },
      },
    });

    assert.equal(envelope.active, false);
    assert.equal(envelope.deactivatedAt, "2026-06-20T18:27:05.423Z");
    assert.equal(envelope.deactivationReason, "session_stop");
    assert.equal(
      envelope.continuationBoundary.mode,
      "session_stop_requires_new_run_or_offline_audit",
    );
    assert.match(envelope.continuationBoundary.reason, /Inactive run status/);
  });

  test("skill and notice template describe the public status surface", async () => {
    const skill = await readRepoFile("canonical/skills/meta-theory/SKILL.md");
    const notice = await readRepoFile(
      "canonical/templates/user-interaction/notice-template.md",
    );
    const combined = `${skill}\n${notice}`;

    assert.match(combined, /runStatusEnvelope/);
    assert.match(combined, /\.meta-kim\/state\/\{profile\}\/active-run\.json/);
    assert.match(combined, /\{localizedActiveLabel\}: \{Current Stage\}/);
    assert.match(combined, /runtime\/tool selected output language first/);
    assert.match(combined, /publicLabels/);
    assert.match(combined, /latest input language/);
    assert.match(combined, /Do not hardcode|hardcode/i);
    assert.match(combined, /must not expose internal protocol fields/i);
    assert.match(combined, /normal assistant chat|ordinary assistant chat/i);
    assert.match(combined, /HookPrompt\s*\/\s*`additionalContext`/i);
    assert.match(combined, /route selected before Execution/i);
    assert.match(combined, /Preflight/);
    assert.match(combined, /conversation_fallback/);
  });

  test("public notice template does not make English labels the default", async () => {
    const notice = await readRepoFile(
      "canonical/templates/user-interaction/notice-template.md",
    );

    assert.doesNotMatch(
      notice,
      /```markdown\s*Meta governance active: \{Current Stage\}/,
      "notice template must start from localized labels, not fixed English labels",
    );
    assert.match(notice, /Do not hardcode any single human language/);
  });

  test("status CLI resolves inactive output from the shared default locale", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-status-cli-"));
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(__dirname, "..", "..", "scripts", "meta-run-status.mjs")],
        {
          cwd: tempDir,
          encoding: "utf8",
          env: {
            ...process.env,
            META_KIM_OUTPUT_LANGUAGE: "zh",
          },
        },
      );

      assert.equal(result.status, 0);
      assert.match(result.stdout, /Meta_Kim 治理状态：未运行/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("status CLI reports inactive session-stop boundary without active label", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-status-cli-"));
    try {
      const spine = await import(
        `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?cliStopped=${Date.now()}`
      );
      const statusDir = path.join(tempDir, ".meta-kim", "state", "default");
      await mkdir(statusDir, { recursive: true });
      const stoppedState = {
        ...spine.createInitialState({ taskClassification: "cli_stopped" }),
        active: false,
        lifecycleStatus: "session_stopped",
        runId: "meta-stopped-cli",
        deactivatedAt: "2026-06-20T18:27:05.423Z",
        deactivationReason: "session_stop",
      };
      await writeFile(
        path.join(statusDir, "active-run.json"),
        JSON.stringify(spine.createMetaRunStatusEnvelope(stoppedState), null, 2),
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [
          path.join(__dirname, "..", "..", "scripts", "meta-run-status.mjs"),
          "--lang",
          "en",
        ],
        {
          cwd: tempDir,
          encoding: "utf8",
        },
      );

      assert.equal(result.status, 0);
      assert.match(result.stdout, /meta_governance_status=inactive/);
      assert.match(result.stdout, /reason=session stopped/);
      assert.match(result.stdout, /continuation=continue from local context or start a new run/);
      assert.doesNotMatch(result.stdout, /meta_governance_active/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("status CLI uses runtime-provided active output labels", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-status-cli-"));
    try {
      const spine = await import(
        `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?cli=${Date.now()}`
      );
      const state = {
        ...spine.createInitialState({ taskClassification: "cli_status_test" }),
        runId: "meta-cli-status-labels",
        task: "raw internal task text must never reach disk",
        taskFingerprint: `hmac-sha256:${"a".repeat(64)}`,
        taskIdentitySource: "project_profile_hmac_sha256",
        intentCard: {
          task: "nested intent secret",
          safeLabel: "intent-safe",
          items: [{ rawPromptText: "nested array secret" }],
        },
        reviewPacket: { userPrompt: "nested review secret", safeVerdict: "pass" },
        dispatchChain: [{ worker: { promptText: "nested worker secret", owner: "test" } }],
        safeBoundary: Object.assign(Object.create(null), {
          dense: [null, true, 0, "ok"],
          nested: { value: 1 },
        }),
        currentStage: "fetch",
        stagePurpose: "P_FETCH",
        publicLabels: {
          active: "L_ACTIVE",
          completed: "L_DONE",
          current: "L_CURRENT",
          next: "L_NEXT",
          blocked: "L_BLOCKED",
          none: "L_NONE",
          separator: "=>",
          listSeparator: "|",
        },
      };
      state.stages.critical = { status: "completed", completedAt: new Date().toISOString() };
      state.stages.fetch = { status: "in_progress", completedAt: null };
      await spine.writeSpineState(tempDir, state);

      const result = spawnSync(
        process.execPath,
        [path.join(__dirname, "..", "..", "scripts", "meta-run-status.mjs")],
        {
          cwd: tempDir,
          encoding: "utf8",
        },
      );

      assert.equal(result.status, 0);
      assert.match(result.stdout, /L_ACTIVE=>Fetch/);
      assert.match(result.stdout, /L_DONE=>Critical/);
      assert.match(result.stdout, /L_CURRENT=>P_FETCH/);
      assert.match(result.stdout, /L_NEXT=>Thinking/);
      assert.match(result.stdout, /L_BLOCKED=>L_NONE/);
      assert.doesNotMatch(result.stdout, /^Completed:/m);
      assert.doesNotMatch(result.stdout, /^Current:/m);
      assert.doesNotMatch(result.stdout, /^Next:/m);
      assert.doesNotMatch(result.stdout, /^Blocked:/m);
      assert.doesNotMatch(result.stdout, /raw internal task text/);
      for (const persistedPath of [
        path.join(
          tempDir,
          ".meta-kim",
          "state",
          "default",
          "spine",
          "spine-state.json",
        ),
        path.join(tempDir, ".meta-kim", "state", "default", "active-run.json"),
        path.join(
          tempDir,
          ".meta-kim",
          "state",
          "default",
          "runs",
          state.runId,
          "status.json",
        ),
      ]) {
        const persisted = await readFile(persistedPath, "utf8");
        assert.doesNotMatch(
          persisted,
          /raw internal task text|nested intent secret|nested array secret|nested review secret|nested worker secret|"task"/u,
        );
        assert.match(persisted, /hmac-sha256:[a-f0-9]{64}/u);
      }
      const persistedSpine = await readFile(path.join(
        tempDir,
        ".meta-kim",
        "state",
        "default",
        "spine",
        "spine-state.json",
      ), "utf8");
      assert.match(persistedSpine, /intent-safe/u);
      assert.match(persistedSpine, /safeVerdict/u);
      assert.match(persistedSpine, /"owner": "test"/u);
      assert.match(persistedSpine, /"dense": \[/u);
      assert.doesNotMatch(
        result.stdout,
        /nested intent secret|nested array secret|nested review secret|nested worker secret/u,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("non-JSON state is rejected before mutation without executing getters or toJSON", async () => {
    const spine = await import(
      `../../canonical/runtime-assets/shared/hooks/spine-state.mjs?jsonBoundary=${Date.now()}`
    );
    let getterCalls = 0;
    let toJsonCalls = 0;
    const cases = [
      ["undefined", (state) => { state.intentCard = { value: undefined }; }],
      ["function", (state) => { state.intentCard = { value: () => "unsafe" }; }],
      ["symbol-value", (state) => { state.intentCard = { value: Symbol("unsafe") }; }],
      ["bigint", (state) => { state.intentCard = { value: 1n }; }],
      ["non-finite", (state) => { state.intentCard = { value: Number.NaN }; }],
      ["accessor", (state) => {
        state.intentCard = {};
        Object.defineProperty(state.intentCard, "value", {
          enumerable: true,
          get() { getterCalls += 1; return "unsafe"; },
        });
      }],
      ["toJSON", (state) => {
        state.intentCard = {
          safe: true,
          toJSON() { toJsonCalls += 1; return { safe: false }; },
        };
      }],
      ["custom-prototype", (state) => {
        const prototype = {};
        Object.defineProperty(prototype, "inherited", {
          get() { getterCalls += 1; return "unsafe"; },
        });
        state.intentCard = Object.assign(Object.create(prototype), { safe: true });
      }],
      ["reserved-proto", (state) => {
        state.intentCard = { safe: true };
        Object.defineProperty(state.intentCard, "__proto__", {
          value: { polluted: true },
          enumerable: true,
        });
      }],
      ["symbol-key", (state) => {
        state.intentCard = { safe: true };
        state.intentCard[Symbol("unsafe")] = true;
      }],
      ["non-enumerable", (state) => {
        state.intentCard = { safe: true };
        Object.defineProperty(state.intentCard, "hidden", { value: true });
      }],
      ["sparse-array", (state) => {
        state.intentCard = { values: new Array(2) };
        state.intentCard.values[1] = "present";
      }],
      ["decorated-array", (state) => {
        const values = ["safe"];
        values.extra = "unsafe";
        state.intentCard = { values };
      }],
      ["array-accessor", (state) => {
        const values = ["placeholder"];
        Object.defineProperty(values, "0", {
          enumerable: true,
          get() { getterCalls += 1; return "unsafe"; },
        });
        state.intentCard = { values };
      }],
      ["cycle", (state) => {
        state.intentCard = { safeLabel: "cycle" };
        state.intentCard.self = state.intentCard;
      }],
    ];
    const writers = [
      (cwd, state) => spine.writeSpineState(cwd, state),
      (cwd, state) => spine.activateSpineState(cwd, state),
      (cwd, state) => spine.writeMetaRunStatus(cwd, state),
    ];

    for (let writerIndex = 0; writerIndex < writers.length; writerIndex += 1) {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), `meta-kim-profile-accessor-${writerIndex}-`));
      try {
        const state = spine.createInitialState({ taskClassification: "profile_accessor" });
        Object.defineProperty(state, "profile", {
          enumerable: true,
          get() { getterCalls += 1; return "getter-controlled-profile"; },
        });
        await assert.rejects(
          writers[writerIndex](tempDir, state),
          /Unsafe Meta_Kim JSON boundary value: accessor property profile/u,
        );
        await assert.rejects(readFile(path.join(tempDir, ".meta-kim"), "utf8"), {
          code: "ENOENT",
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }

    const optionGetterDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-option-profile-accessor-"));
    try {
      const state = spine.createInitialState({ taskClassification: "option_profile_accessor" });
      const unsafeOptions = {};
      Object.defineProperty(unsafeOptions, "profile", {
        enumerable: true,
        get() { getterCalls += 1; return "getter-controlled-options-profile"; },
      });
      await assert.rejects(
        spine.writeMetaRunStatus(optionGetterDir, state, unsafeOptions),
        /routing field profile must be an own enumerable data property/u,
      );
      await assert.rejects(readFile(path.join(optionGetterDir, ".meta-kim"), "utf8"), {
        code: "ENOENT",
      });
    } finally {
      await rm(optionGetterDir, { recursive: true, force: true });
    }

    for (let index = 0; index < cases.length; index += 1) {
      const [label, makeUnsafe] = cases[index];
      const tempDir = await mkdtemp(path.join(os.tmpdir(), `meta-kim-json-${label}-`));
      try {
        const state = spine.createInitialState({ taskClassification: "json_boundary" });
        makeUnsafe(state);
        await assert.rejects(
          writers[index % writers.length](tempDir, state),
          /Unsafe Meta_Kim JSON boundary|Cyclic Meta_Kim state/u,
          label,
        );
        await assert.rejects(
          readFile(path.join(tempDir, ".meta-kim"), "utf8"),
          { code: "ENOENT" },
          `${label} must fail before creating state`,
        );
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }

    const priorProfileDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "profile");
    Object.defineProperty(Object.prototype, "profile", {
      value: "prototype-controlled-profile",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    try {
      for (let writerIndex = 0; writerIndex < writers.length; writerIndex += 1) {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), `meta-kim-profile-prototype-${writerIndex}-`));
        try {
          const state = spine.createInitialState({ taskClassification: "profile_prototype" });
          await writers[writerIndex](tempDir, state);
          const defaultStatus = path.join(
            tempDir,
            ".meta-kim",
            "state",
            "default",
            "active-run.json",
          );
          assert.equal(JSON.parse(await readFile(defaultStatus, "utf8")).runId, state.runId);
          await assert.rejects(
            readFile(path.join(
              tempDir,
              ".meta-kim",
              "state",
              "prototype-controlled-profile",
              "active-run.json",
            ), "utf8"),
            { code: "ENOENT" },
          );
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }
      }
    } finally {
      if (priorProfileDescriptor) {
        Object.defineProperty(Object.prototype, "profile", priorProfileDescriptor);
      } else {
        delete Object.prototype.profile;
      }
    }
    assert.equal(getterCalls, 0);
    assert.equal(toJsonCalls, 0);
  });

  test("status CLI summarizes latest governed execution artifact", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-status-cli-"));
    try {
      const executionDir = path.join(
        tempDir,
        ".meta-kim",
        "state",
        "default",
        "governed-executions",
      );
      await mkdir(executionDir, { recursive: true });

      const runId = "meta-latest-demo";
      const jsonPath = `.meta-kim/state/default/governed-executions/${runId}.json`;
      const markdownPath = `.meta-kim/state/default/governed-executions/${runId}.zh-CN.md`;
      await writeFile(
        path.join(executionDir, "latest.json"),
        JSON.stringify(
          {
            runId,
            jsonPath,
            markdownPath,
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(
        path.join(executionDir, `${runId}.json`),
        JSON.stringify(
          {
            runId,
            status: "pass",
            task: "demo task",
            publicReadyDecision: {
              publicReady: false,
              status: "partial",
            },
            runReportPanelContract: {
              decisionSummary: {
                plainLanguageSummary: "demo summary",
              },
              ownerHandoff: [
                {
                  owner: "meta-conductor",
                  mergeOwner: "meta-warden",
                  verificationOwner: "verify",
                },
              ],
            },
            runtimeEvidencePacket: {
              records: [
                {
                  runtime: "codex",
                  status: "pass",
                  evidenceKind: "runtime_live_pass",
                  failureClass: "pass",
                  strictReleasePass: true,
                },
                {
                  runtime: "cursor",
                  status: "blocked",
                  evidenceKind: "unsupported",
                  failureClass: "native_harness_missing",
                  strictReleasePass: false,
                  remainingAction:
                    "Keep Cursor as compatibility until native harness is available.",
                },
              ],
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [
          path.join(__dirname, "..", "..", "scripts", "meta-run-status.mjs"),
          "--latest",
          "--lang",
          "en",
          "--details",
        ],
        {
          cwd: tempDir,
          encoding: "utf8",
        },
      );

      assert.equal(result.status, 0);
      assert.match(result.stdout, /Latest governed run/);
      assert.match(result.stdout, /latest_run=meta-latest-demo/);
      assert.match(result.stdout, /task=demo task/);
      assert.match(result.stdout, /status=passed/);
      assert.match(result.stdout, /public_ready=no/);
      assert.match(result.stdout, /summary=demo summary/);
      assert.match(
        result.stdout,
        /owner_handoff=meta-conductor->meta-warden\/verify/,
      );
      assert.match(
        result.stdout,
        /runtime_evidence=codex:passed\/runtime_live_pass\/passed; cursor:blocked\/unsupported\/native_harness_missing/,
      );
      assert.match(
        result.stdout,
        /release_boundary=cursor: Keep Cursor as compatibility until native harness is available\./,
      );
      assert.match(result.stdout, new RegExp(`report=${markdownPath}`));
      assert.match(
        result.stdout,
        /next_command=npm run meta:theory:report -- --run-id meta-latest-demo/,
      );
      const escapedTempDir = tempDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.doesNotMatch(result.stdout, new RegExp(escapedTempDir));

      const localized = [
        ["zh", /最近一次治理运行/, /状态：通过/, /可交付：否/],
        ["ja", /最新のガバナンス実行/, /状態：合格/, /公開準備：いいえ/],
        ["ko", /최근 거버넌스 실행/, /상태: 통과/, /공개 준비: 아니요/],
      ];
      for (const [language, title, statusLabel, readyLabel] of localized) {
        const localeResult = spawnSync(
          process.execPath,
          [
            path.join(__dirname, "..", "..", "scripts", "meta-run-status.mjs"),
            "--latest",
            "--lang",
            language,
          ],
          { cwd: tempDir, encoding: "utf8" },
        );
        assert.equal(localeResult.status, 0, localeResult.stderr);
        assert.match(localeResult.stdout, title);
        assert.match(localeResult.stdout, statusLabel);
        assert.match(localeResult.stdout, readyLabel);
        assert.match(localeResult.stdout, /demo summary/);
        assert.doesNotMatch(localeResult.stdout, /owner_handoff|runtime_evidence/);
      }

      const jsonResult = spawnSync(
        process.execPath,
        [
          path.join(__dirname, "..", "..", "scripts", "meta-run-status.mjs"),
          "--latest",
          "--lang",
          "zh",
          "--json",
        ],
        { cwd: tempDir, encoding: "utf8" },
      );
      const machineSummary = JSON.parse(jsonResult.stdout);
      assert.equal(machineSummary.status, "pass");
      assert.equal(machineSummary.publicReady, "false");
      assert.equal(machineSummary.task, "demo task");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("status CLI rejects latest artifact paths outside governed execution state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-status-cli-"));
    try {
      const executionDir = path.join(
        tempDir,
        ".meta-kim",
        "state",
        "default",
        "governed-executions",
      );
      await mkdir(executionDir, { recursive: true });
      await writeFile(
        path.join(executionDir, "latest.json"),
        JSON.stringify(
          {
            runId: "unsafe-demo",
            jsonPath: "outside.json",
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(
        path.join(tempDir, "outside.json"),
        JSON.stringify({ runId: "unsafe-demo" }, null, 2),
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [
          path.join(__dirname, "..", "..", "scripts", "meta-run-status.mjs"),
          "--latest",
        ],
        {
          cwd: tempDir,
          encoding: "utf8",
        },
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Refusing to read governed execution artifact/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
