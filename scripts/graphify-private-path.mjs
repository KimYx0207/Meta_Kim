export function hasPrivateLocalPath(value) {
  return typeof value === "string" &&
    /(?:(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|(?:^|[^A-Za-z0-9_])~[\\/]|\/(?:Users|home|root)\/)/u.test(
      value,
    );
}
