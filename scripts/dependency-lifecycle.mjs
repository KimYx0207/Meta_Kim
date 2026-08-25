/**
 * Dependency provider lifecycle helpers.
 *
 * The discovery index is intentionally a read-only inventory.  A path or a
 * registry row can prove that a provider is available as source material, but
 * only an exact, still-valid managed ownership receipt can prove installation.
 */

export const DEPENDENCY_LIFECYCLE_STATES = Object.freeze([
  "reference_only",
  "available_not_installed",
  "installed_provider",
  "active_for_run",
]);

const SHA256 = /^[a-f0-9]{64}$/u;

export function redactUserPath(value, { userHome, repoRoot } = {}) {
  if (value == null) return null;
  const raw = String(value).replaceAll("\\", "/");
  const normalizedHome = userHome
    ? String(userHome).replaceAll("\\", "/").replace(/\/$/u, "")
    : null;
  const normalizedRepo = repoRoot
    ? String(repoRoot).replaceAll("\\", "/").replace(/\/$/u, "")
    : null;
  const homePattern = normalizedHome
    ? new RegExp(`^${escapeRegExp(normalizedHome)}(?:/|$)`, "iu")
    : null;
  if (homePattern?.test(raw)) {
    return `~/${raw.slice(normalizedHome.length).replace(/^\//u, "")}`;
  }
  if (normalizedRepo && raw.toLowerCase() === normalizedRepo.toLowerCase()) {
    return ".";
  }
  if (normalizedRepo) {
    const repoPrefix = `${normalizedRepo}/`;
    if (raw.toLowerCase().startsWith(repoPrefix.toLowerCase())) {
      return `./${raw.slice(repoPrefix.length)}`;
    }
  }
  // A dependency index is persisted and may be copied between machines.  Do
  // not leak an arbitrary absolute path even when it is outside this repo.
  if (/^(?:[A-Za-z]:\/|\/\/|\/)/u.test(raw)) return "<local-path>";
  return raw;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function classifyDependencyLifecycle({
  providerId = null,
  isReference = false,
  isAvailable = false,
  managedReceipt = null,
  activeEvidence = null,
} = {}) {
  if (isReference) return "reference_only";
  const activationMatches = Boolean(
    managedReceipt &&
    activeEvidence?.explicit === true &&
    typeof activeEvidence?.runId === "string" &&
    activeEvidence.runId.length > 0 &&
    activeEvidence?.providerId === providerId &&
    activeEvidence?.receiptDigest === managedReceipt.digest,
  );
  if (activationMatches) return "active_for_run";
  if (managedReceipt) return "installed_provider";
  if (isAvailable) return "available_not_installed";
  return "reference_only";
}

export function buildOwnershipReceipt({
  manifest,
  entry,
  runtime,
  path: targetPath = null,
  userHome,
  repoRoot,
} = {}) {
  if (!entry || entry.kind !== "dir" || entry.category !== "A") return null;
  if (!SHA256.test(String(entry.directoryClosureSha256 ?? ""))) return null;
  if (!Number.isSafeInteger(entry.directoryClosureEntryCount) || entry.directoryClosureEntryCount < 0) return null;
  return {
    source: entry.providerSource ?? entry.source ?? "install-manifest",
    version: entry.providerVersion ?? null,
    revision: entry.revision ?? entry.directoryClosureSha256,
    digest: entry.directoryClosureSha256,
    runtime: runtime ?? entry.runtimeTarget ?? null,
    ownership: "install_projection",
    ownershipReceipt: {
      manifest: "~/.meta-kim/install-manifest.json",
      receiptVersion: manifest?.metaKimVersion ?? null,
      category: "A",
      purpose: entry.purpose ?? null,
      installedAt: entry.installedAt ?? null,
      path: redactUserPath(targetPath, { userHome, repoRoot }),
      closureEntryCount: entry.directoryClosureEntryCount,
    },
  };
}

export function lifecycleRouteEligibility({
  lifecycleState,
  declaredRouteEligibility,
} = {}) {
  if (lifecycleState === "reference_only") return "reference_only";
  if (lifecycleState === "available_not_installed") return "available_not_installed";
  return declaredRouteEligibility ?? "unknown";
}

export function isSha256(value) {
  return SHA256.test(String(value ?? ""));
}
