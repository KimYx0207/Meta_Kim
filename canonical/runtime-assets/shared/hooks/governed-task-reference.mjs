import { createHash } from "node:crypto";

/** Stable public display reference only; callers must bind resolution to a trusted run. */
export function publicTaskBinding(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  if (/^task:[a-f0-9]{20}$/u.test(value)) return value;
  return `task:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 20)}`;
}
