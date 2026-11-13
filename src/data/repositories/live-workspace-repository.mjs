import { constants } from "node:fs";
import { open, mkdir, readFile, writeFile, copyFile, chmod, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { inspectTrustedPath, inspectPlainAbsolutePath } from "../../../scripts/safe-managed-file-operations.mjs";
import { readSpineStateIncludingInactive, writeSpineState, validateCanonicalStateProfile } from "../../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { workspaceRequire, workspaceFailure, workspaceBytesDigest, workspaceVersion } from "../../domain/live/live-workspace.mjs";

/** Private material I/O and the existing spine CAS. No shadow execution DB. */
export function createLiveWorkspaceRepository({ projectRoot, profile = "default", policy }) {
  const root = path.resolve(projectRoot);
  validateCanonicalStateProfile(profile);
  workspaceRequire(inspectPlainAbsolutePath(root, { kind: "directory" }), "workspace_project_root_invalid", 403);
  const trusted = (ref, allowMissing = false) => {
    workspaceRequire(typeof ref === "string" && ref.length <= 2048 && !path.isAbsolute(ref) && !ref.includes("\\") &&
      !ref.split("/").some(part => !part || part === "." || part === ".."), "workspace_material_path_invalid", 403);
    const checked = inspectTrustedPath(root, ref, { allowMissing });
    workspaceRequire(checked, "workspace_material_path_untrusted", 403);
    return checked.target;
  };
  async function inspect(ref, expected = null, maxBytes = policy.maxMaterialBytes) {
    const target = trusted(ref);
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const before = await handle.stat();
      workspaceRequire(before.isFile() && before.size <= maxBytes, "workspace_material_too_large", 413);
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position <= maxBytes) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes + 1 - position), position);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
        workspaceRequire(position <= maxBytes, "workspace_material_too_large", 413);
      }
      const after = await handle.stat();
      const current = await stat(trusted(ref));
      workspaceRequire(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs &&
        current.dev === after.dev && current.ino === after.ino, "workspace_material_changed", 409);
      const sha256 = hash.digest("hex");
      workspaceRequire(!expected || expected === sha256, "workspace_material_changed", 409);
      return { sha256, bytes: position };
    } finally { await handle.close(); }
  }
  async function ensureParent(ref) {
    trusted(ref, true);
    await mkdir(path.dirname(path.join(root, ref)), { recursive: true, mode: 0o700 });
    trusted(ref, true);
  }
  async function putBytes(runId, bytes, format = "text") {
    workspaceRequire(Buffer.isBuffer(bytes) && bytes.length <= policy.maxMaterialBytes, "workspace_material_too_large", 413);
    const sha256 = workspaceBytesDigest(bytes);
    const ref = `.meta-kim/work/live-workspace/${workspaceBytesDigest(Buffer.from(runId))}/materials/${sha256}.txt`;
    await ensureParent(ref);
    try { await writeFile(trusted(ref, true), bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    await inspect(ref, sha256);
    return { ref, sha256, bytes: bytes.length, format };
  }
  async function putSource(runId, sourceRef, format = "text") {
    const source = await inspect(sourceRef);
    const ref = `.meta-kim/work/live-workspace/${workspaceBytesDigest(Buffer.from(runId))}/materials/${source.sha256}.txt`;
    await ensureParent(ref);
    try { await copyFile(trusted(sourceRef), trusted(ref, true), constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    await chmod(trusted(ref), 0o600);
    await inspect(ref, source.sha256);
    await inspect(sourceRef, source.sha256);
    return { ref, sourceRef, sourceSha256: source.sha256, ...source, format };
  }
  async function verifyMaterial(material, { requireSourceCurrent = true } = {}) {
    workspaceRequire(material && /^[a-f0-9]{64}$/u.test(material.sha256), "workspace_material_unknown", 404);
    if (requireSourceCurrent && material.sourceRef) await inspect(material.sourceRef, material.sourceSha256);
    return inspect(material.ref, material.sha256);
  }
  // Display-only memoization: no review, claim, or receipt may use it.
  // Recheck trusted paths and nanosecond file identity on every poll; only
  // stable files reuse their digest. The normal verifier always hashes fresh.
  const displayChecks = new Map();
  async function displayInspect(ref, expected) {
    const signature = async () => {
      const info = await stat(trusted(ref), { bigint: true });
      workspaceRequire(info.isFile(), "workspace_material_path_untrusted", 403);
      return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
    };
    const before = await signature();
    const key = `${ref}:${expected}`;
    const cached = displayChecks.get(key);
    if (cached?.signature === before) {
      if (cached.error) throw workspaceFailure(cached.error, 409);
      return { ...cached.result, cached: true };
    }
    let result, failure;
    try { result = await inspect(ref, expected); }
    catch (error) { if (error.code !== "workspace_material_changed") throw error; failure = error; }
    const after = await signature();
    workspaceRequire(before === after, "workspace_material_changed", 409);
    displayChecks.delete(key);
    displayChecks.set(key, { signature: after, result, error: failure?.code });
    while (displayChecks.size > 2 * (policy.maxModules + 1)) displayChecks.delete(displayChecks.keys().next().value);
    if (failure) throw failure;
    return { ...result, cached: false };
  }
  async function verifyMaterialForDisplay(material) {
    workspaceRequire(material && /^[a-f0-9]{64}$/u.test(material.sha256), "workspace_material_unknown", 404);
    if (material.sourceRef) await displayInspect(material.sourceRef, material.sourceSha256);
    return displayInspect(material.ref, material.sha256);
  }
  async function materialPage(material, { version, cursor = null }) {
    workspaceRequire(version === workspaceVersion(material.sha256), "workspace_material_version_conflict", 409);
    await verifyMaterial(material, { requireSourceCurrent: false });
    let offset = 0;
    if (cursor) {
      workspaceRequire(typeof cursor === "string" && cursor.length <= 512, "workspace_cursor_invalid");
      let decoded;
      try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw workspaceFailure("workspace_cursor_invalid"); }
      workspaceRequire(decoded.version === version && decoded.artifactId === material.artifactId && Number.isSafeInteger(decoded.offset) && decoded.offset >= 0,
        "workspace_cursor_version_conflict", 409);
      offset = decoded.offset;
    }
    workspaceRequire(offset <= material.bytes, "workspace_cursor_invalid");
    const handle = await open(trusted(material.ref), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let text, used;
    try {
      const buffer = Buffer.alloc(Math.min(policy.materialPageBytes + 4, material.bytes - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      used = Math.min(bytesRead, policy.materialPageBytes);
      // A continuation byte belongs to the preceding code point, so leave that
      // complete code point for the next page. Reject malformed source UTF-8.
      while (used > 0 && used < bytesRead && (buffer[used] & 0xc0) === 0x80) used -= 1;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, used)); }
      catch { throw workspaceFailure("workspace_material_utf8_required", 415); }
    } finally { await handle.close(); }
    await verifyMaterial(material, { requireSourceCurrent: false });
    let sourceState = "current";
    if (material.sourceRef) {
      try { await inspect(material.sourceRef, material.sourceSha256); }
      catch (error) { if (["workspace_material_changed", "workspace_material_path_untrusted", "ENOENT"].includes(error.code)) sourceState = "changed"; else throw error; }
    }
    const eof = offset + used >= material.bytes;
    return { schemaVersion: "meta-kim-live-workspace-material-v1", artifactId: material.artifactId, version, sha256: material.sha256,
      format: material.format, text, totalBytes: material.bytes, eof, sourceState,
      nextCursor: eof ? null : Buffer.from(JSON.stringify({ artifactId: material.artifactId, version, offset: offset + used })).toString("base64url") };
  }
  return { projectRoot: root, profile, trusted, inspect, putBytes, putSource, verifyMaterial, verifyMaterialForDisplay, materialPage,
    async historicalReviewMaterial(runId, review) {
      workspaceRequire(review && /^[a-f0-9]{64}$/u.test(review.sha256 || "") && review.version === workspaceVersion(review.sha256),
        "workspace_historical_material_binding_invalid", 409);
      const ref = `.meta-kim/work/live-workspace/${workspaceBytesDigest(Buffer.from(runId))}/materials/${review.sha256}.txt`;
      const observed = await inspect(ref, review.sha256);
      return { ref, ...observed, artifactId: review.artifactId, format: review.materialFormat || "text" };
    },
    async readState() { return readSpineStateIncludingInactive(root, { profile }); },
    async readPublishedDesign(runId) {
      workspaceRequire(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId), "workspace_run_invalid");
      const candidates = [`.meta-kim/state/${profile}/governed-executions/${runId}.json`,
        `.meta-kim/state/${profile}/runs/${runId}/artifact.json`, `.meta-kim/state/${profile}/runs/${runId}/run.json`];
      for (const ref of candidates) {
        try {
          const observed = await inspect(ref, null, policy.maxDesignBytes);
          const bytes = await readFile(trusted(ref));
          workspaceRequire(workspaceBytesDigest(bytes) === observed.sha256, "workspace_material_changed", 409);
          const artifact = JSON.parse(bytes.toString("utf8"));
          if (artifact.runId !== runId) continue;
          const design = artifact.productDesignPacket || artifact.coreLoop?.productDesignPacket;
          if (design?.softwareDesign?.architecture && Array.isArray(design.softwareDesign.modules)) return { design, sha256: observed.sha256,
            recordOrigin: artifact.recordOrigin };
        } catch (error) { if (!["ENOENT", "workspace_material_path_untrusted"].includes(error.code)) throw error; }
      }
      return null;
    },
    async readHistoricalState(runId) {
      workspaceRequire(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId), "workspace_run_invalid");
      const ref = `.meta-kim/state/${profile}/runs/${runId}/workspace.private.json`;
      try {
        await inspect(ref, null, policy.maxArchiveBytes);
        const record = JSON.parse(await readFile(trusted(ref), "utf8"));
        workspaceRequire(record.schemaVersion === "meta-kim-live-workspace-archive-v1" && record.runId === runId &&
          record.profile === profile && record.active === false && record.archivedProjection === true &&
          record.liveWorkspace?.runId === runId, "workspace_archive_invalid", 409);
        return record;
      } catch (error) { if (["ENOENT", "workspace_material_path_untrusted"].includes(error.code)) return null; throw error; }
    },
    async readJson(ref, limit = policy.maxDesignBytes) {
      await inspect(ref, null, limit);
      const bytes = await readFile(trusted(ref));
      workspaceRequire(bytes.length <= limit, "workspace_input_too_large", 413);
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw workspaceFailure("workspace_input_json_invalid"); }
    },
    async writeState(previous, next) {
      workspaceRequire(next.runId === previous.runId && next.active === true &&
        Buffer.byteLength(JSON.stringify(next.liveWorkspace)) <= policy.maxWorkspaceStateBytes, "workspace_state_limit_or_binding", 413);
      next.hostCheckpointRevision = (previous.hostCheckpointRevision || 0) + 1;
      next.updatedAt = new Date().toISOString();
      const result = await writeSpineState(root, next, { profile, expectedRunId: previous.runId, expectedActive: true,
        expectedStage: previous.currentStage, expectedStageStatus: previous.stages[previous.currentStage].status,
        expectedCheckpointRevision: previous.hostCheckpointRevision || 0 });
      workspaceRequire(result.written, "workspace_revision_conflict", 409);
      return next;
    },
  };
}
