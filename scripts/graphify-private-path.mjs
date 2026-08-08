export function hasPrivateLocalPath(value) {
  return typeof value === "string" &&
    /(?:(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|(?:^|[^A-Za-z0-9_])~[\\/]|\/(?:Users|home|root)\/)/u.test(
      value,
    );
}

// Identity-bearing paths only: a drive letter, a UNC host, or an absolute home
// root all embed a real user or machine name. A bare `~/` does not — it is
// byte-identical on every machine, so documentation that legitimately writes
// `~/.claude/hooks/` is not a leak. `hasPrivateLocalPath` stays broader on
// purpose: its tilde branch is the fail-closed backstop for home-relative
// strings that `sanitizeKnownMetaKimHomeAliases` refused to rewrite.
export function revealsMachineIdentity(value) {
  return typeof value === "string" &&
    /(?:(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:Users|home|root)\/)/u
      .test(value);
}

export function sanitizeKnownMetaKimHomeAliases(value) {
  if (typeof value !== "string" || !value.includes("~/.meta-kim")) return value;
  return value.replace(
    /~\/\.meta-kim[^\s,;:)\]}>'"`]*/gu,
    (candidate) => {
      const segments = candidate.split("/").slice(2);
      return /^~\/\.meta-kim(?:\/[A-Za-z0-9._-]+)*$/u.test(candidate) &&
        segments.every((segment) => segment !== "." && segment !== "..")
        ? candidate.replace(/^~\/\.meta-kim/u, "<meta-kim-home>")
        : candidate;
    },
  );
}
