import {
  assertValidLiveShareArtifact,
  buildLiveShareArtifact as buildDomainLiveShareArtifact,
} from "../../domain/live/live-share-artifact.mjs";

/**
 * Compose the M3-L01 snapshot and optional replay endpoint result into the
 * independently verifiable M3-L02 public artifact. No source reads or writes
 * happen here; callers provide the already-read snapshot/replay values.
 */
export function buildLiveShareArtifact(input) {
  const artifact = buildDomainLiveShareArtifact(input);
  return assertValidLiveShareArtifact(artifact);
}

export const createLiveShareArtifact = buildLiveShareArtifact;
