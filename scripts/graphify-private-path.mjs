export function hasPrivateLocalPath(value) {
  return typeof value === "string" &&
    /(?:(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|(?:^|[^A-Za-z0-9_])~[\\/]|\/(?:Users|home|root)\/)/u.test(
      value,
    );
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
