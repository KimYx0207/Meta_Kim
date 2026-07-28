import { readFileSync } from "node:fs";
import path from "node:path";

// The packed producer and every packed-proof consumer derive target truth from
// the release sync manifest. Do not duplicate the supported runtime list.
export const PACKED_SYNC_MANIFEST = Object.freeze(JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "config", "sync.json"), "utf8"),
));

export const PACKED_USER_TARGETS = Object.freeze([
  ...PACKED_SYNC_MANIFEST.supportedTargets,
]);
