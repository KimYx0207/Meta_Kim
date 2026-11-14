import { loadLiveWorkspacePolicy } from "./live-workspace-policy.mjs";
import { liveRecordOrigin } from "./live-record-origin.mjs";
import { workspaceRequire, workspaceBytesDigest } from "../../domain/live/live-workspace.mjs";

/** Private display projection, separate from the public compact run snapshot.
 * The publisher supplies a digest and identity of the committed source file.
 * Readers check its current file identity; this is display consistency, never
 * source authentication, review acceptance, or execution authority. */
export function prepareLiveWorkspaceDesignRecord(artifact, { profile, source, policy = loadLiveWorkspacePolicy() }) {
  const packet = artifact?.productDesignPacket ?? artifact?.coreLoop?.productDesignPacket;
  const softwareDesign = packet?.softwareDesign;
  if (!softwareDesign?.architecture || !Array.isArray(softwareDesign.modules)) return null;
  const runId = artifact.runId;
  workspaceRequire(typeof runId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId) &&
    typeof profile === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(profile), "workspace_design_projection_binding_invalid", 409);
  const identityKeys = ["dev", "ino", "size", "mtimeNs", "ctimeNs"];
  workspaceRequire(source?.ref === `.meta-kim/state/${profile}/governed-executions/${runId}.json` &&
    /^[a-f0-9]{64}$/u.test(source.sha256 || "") && Number.isSafeInteger(source.bytes) && source.bytes > 0 &&
    identityKeys.every(key => typeof source.identity?.[key] === "string" && /^-?\d+$/u.test(source.identity[key])) &&
    source.identity.size === String(source.bytes), "workspace_design_projection_binding_invalid", 409);
  const softwareBytes = Buffer.from(JSON.stringify(softwareDesign));
  workspaceRequire(softwareBytes.length <= policy.maxDesignBytes, "workspace_material_too_large", 413);
  const projection = {
    schemaVersion: "meta-kim-live-workspace-design-projection-v1", runId, profile,
    recordOrigin: liveRecordOrigin(artifact),
    design: { softwareDesign: JSON.parse(softwareBytes.toString("utf8")) },
    // This describes the original full design; it is not the digest of this subset.
    sourceDesignDigest: typeof packet.designDigest === "string" ? packet.designDigest : null,
    softwareDesignSha256: workspaceBytesDigest(softwareBytes),
    source: { ref: source.ref, sha256: source.sha256, bytes: source.bytes,
      identity: Object.fromEntries(identityKeys.map(key => [key, source.identity[key]])) },
    nativeInvocationVerified: false, completionVerified: false, publicReadyAuthority: false,
    evidenceBoundary: "private_design_display_only; source_digest_recorded_by_publisher; current_source_stat_identity_checked; no_review_or_execution_authority",
  };
  const content = `${JSON.stringify(projection, null, 2)}\n`;
  const bytes = Buffer.byteLength(content, "utf8");
  workspaceRequire(bytes <= policy.maxDesignBytes, "workspace_material_too_large", 413);
  return { projection, content, bytes, sha256: workspaceBytesDigest(Buffer.from(content)) };
}
