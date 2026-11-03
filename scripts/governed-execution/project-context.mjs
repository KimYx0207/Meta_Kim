import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const ignored = new Set([".git", ".meta-kim", "node_modules", "vendor", "target", "dist", "build", ".venv", "venv"]);
const manifests = new Map([
  ["package.json", "JavaScript/TypeScript"], ["pyproject.toml", "Python"], ["requirements.txt", "Python"],
  ["Cargo.toml", "Rust"], ["go.mod", "Go"], ["pom.xml", "Java"], ["build.gradle", "JVM"],
  ["composer.json", "PHP"], ["Gemfile", "Ruby"], ["Package.swift", "Swift"], ["pubspec.yaml", "Dart"],
  ["CMakeLists.txt", "C/C++"],
]);
const lockNames = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "uv.lock", "poetry.lock", "Cargo.lock", "go.sum", "composer.lock"]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const posix = value => value.split(path.sep).join("/");

/** Read bounded project facts before Critical. This is no ninth governance stage
 * and never chooses a language, executes project scripts or alters a worktree. */
export async function inspectProjectContext({ projectRoot, maxDirectories = 32, maxFiles = 96, maxFileBytes = 128 * 1024 } = {}) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) throw new TypeError("Project analysis needs an absolute project root");
  const root = path.resolve(projectRoot);
  const sources = [];
  const modules = [];
  const limitations = [];
  const directories = [{ dir: root, depth: 0 }];
  let visited = 0;
  let entriesSeen = 0;
  while (directories.length && visited < maxDirectories && sources.length < maxFiles) {
    const { dir, depth } = directories.shift();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) {
      if (error.code === "ENOENT" && dir === root) { limitations.push("project_directory_absent"); break; }
      throw error;
    }
    visited++;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name) || entry.name.startsWith(".")) continue;
      entriesSeen++;
      if (entry.isDirectory() && depth < 2) directories.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      if (!entry.isFile() || sources.length >= maxFiles) continue;
      const language = manifests.get(entry.name) ?? (entry.name.endsWith(".csproj") ? ".NET" : null);
      if (!language && !lockNames.has(entry.name) && !/^README(?:\.[a-z-]+)?\.md$/i.test(entry.name) && entry.name !== "AGENTS.md") continue;
      const file = path.join(dir, entry.name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      if (stat.size > maxFileBytes) { limitations.push(`bounded_read_omitted:${posix(path.relative(root, file))}`); continue; }
      const bytes = await fs.readFile(file);
      const sourceRef = posix(path.relative(root, file));
      sources.push({ sourceRef, sha256: hash(bytes), bytes: bytes.length });
      if (!language) continue;
      const content = bytes.toString("utf8");
      const module = { directory: posix(path.relative(root, dir)) || ".", language, sourceRef, versions: {}, entrypoints: {}, frameworkDeclarations: [] };
      if (entry.name === "package.json") {
        try {
          const pkg = JSON.parse(content);
          if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) throw new TypeError("Manifest must be an object");
          module.versions = { ...(typeof pkg.version === "string" ? { package: pkg.version } : {}),
            ...(typeof pkg.packageManager === "string" ? { packageManager: pkg.packageManager } : {}),
            ...(typeof pkg.engines?.node === "string" ? { node: pkg.engines.node } : {}) };
          module.entrypoints = Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter(([, value]) => typeof value === "string"));
          module.frameworkDeclarations = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
            .filter(([name]) => /^(?:typescript|react|vue|next|nuxt|svelte|@angular\/core|express|fastify|electron|@tauri-apps\/api)$/.test(name))
            .map(([name, version]) => ({ name, version }));
          if (module.frameworkDeclarations.some(item => item.name === "typescript")) module.language = "TypeScript/JavaScript";
        } catch (error) {
          if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
          limitations.push(`invalid_manifest:${sourceRef}`);
        }
      } else {
        // These are declared fields only, not a claim to fully parse every build format.
        const version = content.match(/^\s*(?:requires-python|rust-version|version)\s*=\s*["']([^"']+)["']/m)?.[1]
          ?? content.match(/^go\s+(\S+)/m)?.[1];
        if (version) module.versions.declared = version;
        module.declarationReadMode = "bounded_manifest_fields";
      }
      modules.push(module);
    }
  }
  if (directories.length || sources.length >= maxFiles) limitations.push("bounded_scan_partial");
  let worktree = { status: "not_a_git_worktree", changedPaths: [], truncated: false };
  try {
    const result = await execute("git", ["-c", "core.quotepath=false", "status", "--porcelain=v1", "--untracked-files=normal"],
      { cwd: root, windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024 });
    const rows = result.stdout.trimEnd().split(/\r?\n/).filter(Boolean);
    worktree = { status: "observed", changedPaths: rows.slice(0, 200).map(row => row.slice(3)), truncated: rows.length > 200 };
    const head = await execute("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, windowsHide: true, timeout: 3000, maxBuffer: 4096 });
    worktree.headCommit = head.stdout.trim();
  } catch (error) {
    if (!/not a git repository|ENOENT/.test(`${error.code ?? ""} ${error.stderr ?? ""}`)) {
      worktree.status = "unavailable";
      limitations.push("worktree_status_unavailable");
    }
  }
  const lifecycle = sources.length || modules.length ? "existing_project" : entriesSeen ? "unclassified_existing_material" : "new_project";
  const content = { schemaVersion: 1, lifecycle, modules, sources, worktree, limitations };
  return { ...content, digest: hash(JSON.stringify(content)), stagePosition: "before_critical",
    nextStage: "Critical", authority: "observed_project_facts_not_user_intent_or_execution_permission" };
}
