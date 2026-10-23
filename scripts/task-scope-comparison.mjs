/**
 * Normalize lexical aliases for conservative scope comparison only.
 * Original work-order paths stay unchanged. This does not resolve symlinks,
 * junctions, short names or real filesystem identities.
 * @param {string} scope
 * @returns {string|null} Comparison key, or null when the root is unresolved.
 */
export function scopeComparisonKey(scope) {
  if (typeof scope !== "string" || !scope.trim() || scope.includes("\0")) return null;
  const text = scope.replaceAll("\\", "/");
  if (/^[a-z]:[^/]|^[a-z]:$/iu.test(text) || /^\/\/[.?](?:\/|$)/u.test(text)) return null;
  let prefix = "";
  let rest = text;
  if (/^[a-z]:\//iu.test(text)) {
    prefix = text.slice(0, 3);
    rest = text.slice(3);
  } else if (text.startsWith("//")) {
    const unc = /^\/\/([^/]+)\/([^/]+)(?:\/|$)/u.exec(text);
    if (!unc || [".", ".."].includes(unc[1]) || [".", ".."].includes(unc[2])) return null;
    prefix = `//${unc[1]}/${unc[2]}/`;
    rest = text.slice(unc[0].length);
  } else if (text.startsWith("/")) {
    prefix = "/";
    rest = text.slice(1);
  } else if (/^[a-z][a-z\d+.-]*:/iu.test(text)) return null;
  const parts = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  // A whole-root scope cannot establish independent file shards.
  if (!parts.length) return null;
  return `${prefix}${parts.join("/")}`.toLowerCase();
}

/** Compare normalized scope keys, including directory/file overlap. */
export function scopeKeysOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Root identity is lexical only; no project, drive or network mapping is implied. */
function scopeRootKey(key) {
  if (key.startsWith("//")) return /^\/\/[^/]+\/[^/]+/u.exec(key)?.[0] ?? null;
  if (/^[a-z]:\//u.test(key)) return key.slice(0, 3);
  if (key.startsWith("/")) return "/";
  return "relative";
}

/**
 * Prove lexical disjointness only within the same root representation.
 * Without trusted root bindings, a relative, root-relative, drive or UNC path
 * may name the same file; different representations are therefore unknown.
 * @param {string} left Normalized comparison key.
 * @param {string} right Normalized comparison key.
 * @returns {boolean}
 */
export function scopeKeysAreProvablyDisjoint(left, right) {
  const leftRoot = scopeRootKey(left);
  return leftRoot !== null && leftRoot === scopeRootKey(right) && !scopeKeysOverlap(left, right);
}
