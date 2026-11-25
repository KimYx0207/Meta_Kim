import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPythonModule } from "./graphify-runtime.mjs";
import { sanitizedGraphifyGitEnvironment } from "./graphify-worktree-snapshot.mjs";

const manager = fileURLToPath(new URL("./graphify-managed.py", import.meta.url));

export const MANAGED_GRAPHIFY_LINKED_WORKTREE = "Managed Graphify belongs to the main checkout; linked worktree skipped";
export const MANAGED_GRAPHIFY_UNSUPPORTED_PLATFORM = "Repository-managed Graphify is currently supported on macOS/Linux";

export function readManagedGraphRuntime(targetDir) {
  const result = spawnSync("git", ["rev-parse", "--absolute-git-dir", "--git-common-dir"], {
    cwd: targetDir,
    env: sanitizedGraphifyGitEnvironment(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const [gitDir, commonDir] = result.stdout.trimEnd().split(/\r?\n/u);
  const commonRoot = resolve(targetDir, commonDir);
  const stateDir = join(commonRoot, "graphify");
  const configPath = join(stateDir, "config.json");
  const configStat = lstatSync(configPath, { throwIfNoEntry: false });
  if (!configStat) return null;
  if (!configStat.isFile() || !lstatSync(stateDir).isDirectory()) {
    throw new Error(`Managed Graphify configuration must be a plain file: ${configPath}`);
  }
  if (relative(gitDir, commonRoot) !== "") return { linkedWorktree: true };

  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (typeof config?.python !== "string" || !isAbsolute(config.python)) {
    throw new Error(`Managed Graphify requires an absolute Python path: ${configPath}`);
  }
  return { python: { command: config.python, args: [], versionText: "repository-managed Python" } };
}

export function runManagedGraphLifecycle(targetDir, action, python) {
  return runPythonModule(python, [manager, action, "--repo", targetDir], undefined, {
    cwd: targetDir,
    env: { ...process.env, PYTHONNOUSERSITE: "1", PYTHONHASHSEED: "0" },
    stdio: "pipe",
  });
}
