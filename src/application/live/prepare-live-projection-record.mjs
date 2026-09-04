import { createHash } from "node:crypto";

import {
  LIVE_MAX_COMPACT_BYTES,
  buildLiveCompactProjection,
  serializeLiveCompactProjection,
} from "./live-control-room-service.mjs";

// The governed runner and the historical backfill both publish live projections.
// They share this producer so a rebuilt record cannot diverge in bytes, digest,
// or size ceiling from the record the runner would have written itself.
export function prepareLiveProjectionRecord(artifact) {
  const projection = buildLiveCompactProjection(artifact);
  const content = serializeLiveCompactProjection(projection);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > LIVE_MAX_COMPACT_BYTES) {
    throw new Error(`Live compact projection exceeds ${LIVE_MAX_COMPACT_BYTES} bytes.`);
  }
  return {
    projection,
    content,
    bytes,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}
