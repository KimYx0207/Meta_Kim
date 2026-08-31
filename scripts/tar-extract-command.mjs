import path from "node:path";
import process from "node:process";

/**
 * Builds the argv for extracting a tarball with the system `tar`.
 *
 * The only non-obvious part is that the archive is passed as a bare filename
 * with the working directory moved to its parent. GNU tar reads a colon that
 * appears before the first slash of `-f` as an rsh-style `host:path`, so an
 * absolute Windows path makes it fail with `Cannot connect to C: resolve
 * failed`. Its `--force-local` escape hatch is not an option either, because
 * bsdtar — which ships as `C:\Windows\System32\tar.exe` and is what a plain
 * cmd.exe or PowerShell session resolves — rejects the flag outright. Whichever
 * of the two comes first on PATH is not a caller's concern, and a filename with
 * no colon extracts identically under both.
 *
 * `-C` is not affected: it is a plain chdir argument and takes an absolute path
 * under either implementation.
 *
 * Returns the pieces rather than running them, so each caller keeps its own
 * executor, timeout policy and failure reporting.
 */
export function tarExtractCommand(archivePath, targetDir) {
  const archive = path.resolve(archivePath);
  return {
    command: process.platform === "win32" ? "tar.exe" : "tar",
    args: ["-xf", path.basename(archive), "-C", path.resolve(targetDir)],
    cwd: path.dirname(archive),
  };
}
