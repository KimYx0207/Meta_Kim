import os from "node:os";
import { createHash } from "node:crypto";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function redactKnownRoot(value, root, replacement) {
  let output = value;
  for (const variant of [root, String(root ?? "").replace(/\\/g, "/")]) {
    if (!variant) continue;
    output = output.replace(new RegExp(escapeRegExp(variant), "giu"), replacement);
  }
  return output;
}

function isSensitiveKey(value) {
  const normalized = String(value ?? "")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .toUpperCase();
  return /(?:^|_)(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY|TOKEN|SECRET|PASSWORD|KEY|CREDENTIALS?|SESSION(?:_ID)?|COOKIE|SIGNATURE|AUTHORIZATION|AUTH|BEARER)(?:_|$)/u.test(
    normalized,
  );
}

export function sanitizeCapabilityPublicationText(
  value,
  { repoRoot = null, homeDir = os.homedir() } = {},
) {
  let sanitized = String(value ?? "");
  sanitized = redactKnownRoot(sanitized, repoRoot, ".");
  sanitized = redactKnownRoot(sanitized, homeDir, "~");
  sanitized = sanitized
    .replace(/:\/\/[^/@\s]+@/gu, "://[REDACTED_USERINFO]@")
    .replace(
      /([?&])([^=&#\s]+)=([^&#\s]+)/gu,
      (match, separator, key) =>
        isSensitiveKey(key)
          ? `${separator}${key}=[REDACTED_SECRET]`
          : match,
    )
    .replace(/(Authorization:\s*(?:Bearer|Basic)\s+)[^\s"']+/giu, "$1[REDACTED_SECRET]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/giu, "Bearer [REDACTED_SECRET]")
    .replace(
      /(^|[\s,;([{])([A-Za-z][A-Za-z0-9_-]{1,100})\s*[:=]\s*([^\s,;]+)/gu,
      (match, prefix, key) =>
        isSensitiveKey(key) ? `${prefix}${key}=[REDACTED_SECRET]` : match,
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_SECRET]")
    .replace(/(["'])\\\\[^\r\n"']+\1/gu, "$1[REDACTED_UNC_PATH]$1")
    .replace(/(["'])[A-Za-z]:[\\/][^\r\n"']+\1/gu, "$1[REDACTED_ABSOLUTE_PATH]$1")
    .replace(/(["'])\/(?!\/)[^\r\n"']+\1/gu, "$1[REDACTED_POSIX_PATH]$1")
    .replace(/\\\\[^\r\n)\]}]+/gu, "[REDACTED_UNC_PATH]")
    .replace(/[A-Za-z]:[\\/][^\r\n)\]}]+/gu, "[REDACTED_ABSOLUTE_PATH]")
    .replace(
      /(^|[\s=(])\/(?!\/)[^\r\n)\]}]+/gu,
      (match, prefix) => `${prefix}[REDACTED_POSIX_PATH]`,
    );
  return sanitized;
}

export function sanitizeCapabilityPublicationValue(value, options = {}) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCapabilityPublicationValue(item, options));
  }
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => {
      if (key === "developer_instructions" && typeof nested === "string") {
        return [key, {
          present: nested.trim().length > 0,
          length: nested.length,
          contentDigest: createHash("sha256").update(nested).digest("hex"),
        }];
      }
      return [key, sanitizeCapabilityPublicationValue(nested, options)];
    }));
  }
  return typeof value === "string"
    ? sanitizeCapabilityPublicationText(value, options)
    : value;
}
