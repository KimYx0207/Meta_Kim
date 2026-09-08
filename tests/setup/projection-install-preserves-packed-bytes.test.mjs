import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { projectionInstallArgs } from "../../scripts/global-projection-package-store.mjs";

/**
 * The projection store verifies the installed bundle against `npm pack` truth
 * file by file. On a `core.autocrlf=true` checkout that gate failed closed for
 * exactly one file, and the cause was npm rewriting bytes during install rather
 * than a corrupt pack: bin-links' `fixBin` normalizes the CRLF shebang of the
 * file named in `bin` to LF.
 *
 * The argument list is asserted against a real npm install of a real CRLF
 * fixture, not against a remembered string. A guard that only matched the
 * literal "--no-bin-links" would stay green if npm ever stopped rewriting, and
 * would say nothing about whether the rewrite is what breaks the gate.
 */
const CRLF_SHEBANG_SOURCE = "#!/usr/bin/env node\r\nconsole.log(\"projection probe\");\r\n";

function crlfPairs(bytes) {
  return (bytes.toString("latin1").match(/\r\n/gu) || []).length;
}

async function packCrlfFixture(root) {
  const packageRoot = path.join(root, "pkg");
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "meta-kim-crlf-probe",
      version: "1.0.0",
      bin: { "meta-kim-crlf-probe": "bin/cli.mjs" },
      files: ["bin"],
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(packageRoot, "bin", "cli.mjs"), Buffer.from(CRLF_SHEBANG_SOURCE, "utf8"));
  const stdout = execFileSync("npm", ["pack", "--json", "--silent"], {
    cwd: packageRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const filename = JSON.parse(stdout)[0].filename;
  return { packageRoot, archivePath: path.join(packageRoot, filename) };
}

function installWith(args, cwd) {
  execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
}

test("the projection install argument list preserves the packed bytes npm would otherwise rewrite", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-kim-projection-bytes-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const { archivePath } = await packCrlfFixture(root);
  const packedBinBytes = Buffer.from(CRLF_SHEBANG_SOURCE, "utf8");
  assert.equal(crlfPairs(packedBinBytes), 2, "the fixture must actually ship CRLF line endings");

  const installedBin = async (prefixDir) =>
    await readFile(path.join(prefixDir, "node_modules", "meta-kim-crlf-probe", "bin", "cli.mjs"));

  // The default argument list is the control arm. Without it the assertion
  // below cannot tell "npm preserves bytes anyway" from "our flag works".
  const controlPrefix = path.join(root, "control");
  await mkdir(controlPrefix, { recursive: true });
  installWith(
    projectionInstallArgs(controlPrefix, archivePath).filter((arg) => arg !== "--no-bin-links"),
    root,
  );
  const controlBytes = await installedBin(controlPrefix);
  assert.notEqual(
    controlBytes.compare(packedBinBytes),
    0,
    "npm no longer rewrites the bin shebang, so this guard no longer describes a real hazard",
  );
  assert.equal(crlfPairs(controlBytes), 1, "the rewrite is expected to fold exactly the shebang newline");

  const guardedPrefix = path.join(root, "guarded");
  await mkdir(guardedPrefix, { recursive: true });
  installWith(projectionInstallArgs(guardedPrefix, archivePath), root);
  const guardedBytes = await installedBin(guardedPrefix);
  assert.equal(
    guardedBytes.compare(packedBinBytes),
    0,
    "the projection install must reproduce npm pack bytes exactly, or the first-party gate fails closed",
  );

  // The cost of the flag is stated rather than assumed: no .bin shims are
  // generated. Nothing in the projection reads them, and a future change that
  // starts depending on them should fail here first.
  assert.equal(existsSync(path.join(guardedPrefix, "node_modules", ".bin")), false);
});
