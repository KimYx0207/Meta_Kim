import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { checkedPath } from "../capabilities/source-integrity.mjs";

const execute = promisify(execFile);
const hash = value => createHash("sha256").update(value).digest("hex");
const code = /\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|vue|svelte|css|scss|html|rb|php|swift|kt|json|ya?ml|toml)$/iu;
const ignored = /(?:^|\/)(?:node_modules|vendor|dist|build|target|\.git|\.meta-kim|\.venv|venv|coverage)(?:\/|$)|(?:^|\/)\.env(?:\.|$)/u;
const textFiles = new Set(["Makefile", "Dockerfile", "CMakeLists.txt", "Gemfile"]);
const posix = value => value.split(path.sep).join("/");
function relative(root, value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const result = posix(path.relative(root, path.resolve(root, value)));
  return result && !result.startsWith("../") && result !== ".." && !path.isAbsolute(result) ? result : null;
}

async function discoverFiles(root, limit) {
  try {
    const { stdout } = await execute("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, timeout: 4000, maxBuffer: 2 * 1024 * 1024 });
    const files = [...new Set(stdout.split("\0").filter(Boolean))].sort();
    return { files: files.filter(file => !ignored.test(file) && (code.test(file) || textFiles.has(path.posix.basename(file)))), mode: "git_tracked_and_untracked" };
  } catch {
    const files = [], directories = [root]; let visited = 0;
    while (directories.length && visited++ < limit) {
      const dir = directories.shift();
      let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const target = path.join(dir, entry.name), ref = posix(path.relative(root, target));
        if (entry.name.startsWith(".") || ignored.test(ref) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) directories.push(target);
        else if (entry.isFile() && (code.test(ref) || textFiles.has(entry.name))) files.push(ref);
      }
    }
    return { files, mode: "bounded_filesystem_scan", partial: directories.length > 0 };
  }
}

/** Lightweight source navigation when no current Graphify snapshot is available.
 * Literal references are observations, never a complete language/compiler graph
 * or proof that an unreferenced file is dead. Reads current worktree bytes. */
export async function inspectProjectRelations({ projectRoot, focusPaths = [], maxFiles = 512,
  maxFileBytes = 128 * 1024, maxTotalBytes = 4 * 1024 * 1024, maxRelations = 96 } = {}) {
  if (!path.isAbsolute(projectRoot ?? "")) throw new TypeError("Source navigation needs an absolute project root");
  for (const value of [maxFiles, maxFileBytes, maxTotalBytes, maxRelations]) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Source navigation limits must be positive integers");
  const root = path.resolve(projectRoot), discovery = await discoverFiles(root, Math.max(32, maxFiles));
  const focus = [...new Set(focusPaths.map(value => relative(root, value)).filter(Boolean))].slice(0, 24);
  const inFocus = ref => focus.some(target => ref === target || ref.startsWith(target + "/"));
  const all = discovery.files.sort((a, b) => Number(inFocus(b)) - Number(inFocus(a)) || a.localeCompare(b));
  const known = new Set(discovery.files), contents = new Map(), snapshots = [], limitations = [];
  let totalBytes = 0;
  for (const ref of all.slice(0, maxFiles)) {
    let file, bytes;
    try {
      file = await checkedPath(root, ref);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > maxFileBytes) { limitations.push("file_not_read:" + ref); continue; }
      if (totalBytes + stat.size > maxTotalBytes) { limitations.push("byte_budget_reached"); break; }
      bytes = await fs.readFile(file);
      if (bytes.length > maxFileBytes || totalBytes + bytes.length > maxTotalBytes || bytes.includes(0)) { limitations.push("file_not_read:" + ref); continue; }
    } catch { limitations.push("file_unavailable_or_linked:" + ref); continue; }
    totalBytes += bytes.length;
    snapshots.push({ path: ref, sha256: hash(bytes) }); contents.set(ref, bytes.toString("utf8"));
  }
  if (discovery.partial || all.length > maxFiles) limitations.push("file_scan_partial");
  const edges = [], seen = new Set();
  const add = (from, to, line, mechanism) => {
    const key = JSON.stringify([from, to, line]);
    if (from !== to && !seen.has(key)) { seen.add(key); edges.push({ from, to, line, mechanism }); }
  };
  const resolveLiteral = (from, literal) => {
    if (!literal || /\$\{|\*|\0|^[a-z]+:\/\//iu.test(literal)) return [];
    const candidates = [path.posix.normalize(path.posix.join(path.posix.dirname(from), literal)), path.posix.normalize(literal)];
    if (literal.startsWith("/")) return [];
    return [...new Set(candidates.flatMap(candidate => [candidate, ...[".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".py"].map(ext => candidate + ext),
      ...["index.ts", "index.tsx", "index.js", "__init__.py"].map(name => candidate + "/" + name)]).filter(candidate => known.has(candidate)))];
  };
  for (const [ref, content] of contents) {
    for (const match of content.matchAll(/["'`]([^"'`\r\n]{1,300})["'`]/gu)) {
      const literal = match[1];
      // Relative imports and explicit project paths are useful navigation facts.
      if (!literal.includes("/") && !/\.[a-z0-9]{1,8}$/iu.test(literal)) continue;
      const line = content.slice(0, match.index).split("\n").length;
      for (const to of resolveLiteral(ref, literal)) add(ref, to, line, "literal_path_reference");
    }
    if (/\.(?:[cm]?[jt]sx?)$/iu.test(ref) && /(?:import|require)\s*\(\s*[^\s"'`]/u.test(content)) limitations.push("computed_import_requires_review:" + ref);
    if (ref.endsWith(".py")) for (const match of content.matchAll(/^\s*(?:from|import)\s+([A-Za-z_]\w*(?:\.\w+)*)/gmu)) {
      const literal = match[1].replaceAll(".", "/") + ".py";
      for (const to of resolveLiteral(ref, literal)) add(ref, to, content.slice(0, match.index).split("\n").length, "python_module_reference");
    }
  }
  const related = edges.filter(edge => focus.some(ref => edge.from === ref || edge.to === ref || edge.from.startsWith(ref + "/") || edge.to.startsWith(ref + "/")));
  const shown = related.slice(0, maxRelations);
  const selectedPaths = new Set([...focus, ...shown.flatMap(edge => [edge.from, edge.to])]);
  const candidateStatus = focus.map(ref => ({ path: ref, observedInboundCount: edges.filter(edge => edge.to === ref).length,
    deletionReadiness: "requires_usage_and_entrypoint_review", automaticDeletionAllowed: false }));
  const snapshotDigest = hash(JSON.stringify(snapshots));
  const content = { schemaVersion: 1, mode: discovery.mode, snapshotDigest, scannedFileCount: snapshots.length,
    discoveredFileCount: discovery.files.length, focusPaths: focus,
    sourceBindings: snapshots.filter(item => selectedPaths.has(item.path) || inFocus(item.path)), relations: shown, candidateStatus,
    limitations: [...new Set(["Static literal references are incomplete: aliases, dynamic loading, generated files and external consumers require review.",
      ...limitations, ...(related.length > maxRelations ? ["relation_output_partial"] : [])])],
    authority: "current_source_navigation_not_semantic_impact_or_deletion_permission" };
  return { ...content, digest: hash(JSON.stringify(content)) };
}
