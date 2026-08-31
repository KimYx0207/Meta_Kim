import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { tarExtractCommand } from "../../scripts/tar-extract-command.mjs";

/**
 * GNU tar's own reading of an archive operand, restated here rather than
 * imported so the helper is checked against an independent oracle: a colon that
 * appears before the first path separator makes the operand an rsh-style
 * `host:path`, and tar then tries to resolve `C` as a hostname.
 */
function readsAsRemoteSpec(operand) {
  const colon = operand.indexOf(":");
  if (colon === -1) return false;
  const separator = operand.search(/[\\/]/u);
  return separator === -1 || colon < separator;
}

function archiveOperand(args) {
  const flag = args.findIndex((value) => value === "-xf" || value === "-f");
  assert.notEqual(flag, -1, "the command must pass the archive through -f");
  return args[flag + 1];
}

test("the oracle rejects the absolute-path shape that broke extraction", () => {
  assert.equal(readsAsRemoteSpec("C:\\Users\\Kim\\AppData\\Local\\Temp\\meta-kim-3.0.7.tgz"), true);
  assert.equal(readsAsRemoteSpec("C:/Users/Kim/meta-kim-3.0.7.tgz"), true);
  assert.equal(readsAsRemoteSpec("meta-kim-3.0.7.tgz"), false);
  assert.equal(readsAsRemoteSpec("/tmp/meta-kim-3.0.7.tgz"), false);
  assert.equal(readsAsRemoteSpec("./odd:name.tgz"), false, "a colon after a separator is still a local file");
});

test("the archive operand never reads as a remote spec", () => {
  for (const archive of [
    "C:\\Users\\Kim\\AppData\\Local\\Temp\\pack\\meta-kim-3.0.7.tgz",
    "D:/KimProject/Meta_Kim/tmp/candidate.tgz",
    "/tmp/meta-kim/candidate.tgz",
    "candidate.tgz",
  ]) {
    const extraction = tarExtractCommand(archive, os.tmpdir());
    assert.equal(
      readsAsRemoteSpec(archiveOperand(extraction.args)),
      false,
      `${archive} produced an operand tar would treat as a host`,
    );
  }
});

test("the operand and cwd together still address the original archive", () => {
  const archive = path.join(os.tmpdir(), "pack", "candidate.tgz");
  const extraction = tarExtractCommand(archive, path.join(os.tmpdir(), "extract"));
  assert.equal(path.resolve(extraction.cwd, archiveOperand(extraction.args)), path.resolve(archive));
});

test("a relative archive is resolved instead of left dependent on the caller's cwd", () => {
  const extraction = tarExtractCommand("candidate.tgz", "out");
  assert.equal(path.isAbsolute(extraction.cwd), true);
  assert.equal(path.resolve(extraction.cwd, archiveOperand(extraction.args)), path.resolve("candidate.tgz"));
});

test("the extraction target stays absolute so it does not follow the moved cwd", () => {
  const target = path.join(os.tmpdir(), "extract-here");
  const extraction = tarExtractCommand(path.join(os.tmpdir(), "pack", "candidate.tgz"), target);
  const flag = extraction.args.indexOf("-C");
  assert.notEqual(flag, -1, "the command must direct extraction with -C");
  assert.equal(extraction.args[flag + 1], path.resolve(target));
  assert.equal(path.isAbsolute(extraction.args[flag + 1]), true);
});

test("the resolved command extracts a real archive under whichever tar is on PATH", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-tar-extract-"));
  try {
    const packDir = path.join(root, "pack");
    const target = path.join(root, "extract");
    mkdirSync(packDir);
    mkdirSync(target);
    writeFileSync(path.join(packDir, "payload.txt"), "meta-kim", "utf8");
    const tarBinary = process.platform === "win32" ? "tar.exe" : "tar";
    execFileSync(tarBinary, ["-cf", "candidate.tar", "payload.txt"], { cwd: packDir, windowsHide: true });

    const extraction = tarExtractCommand(path.join(packDir, "candidate.tar"), target);
    execFileSync(extraction.command, extraction.args, { cwd: extraction.cwd, windowsHide: true });
    assert.equal(readFileSync(path.join(target, "payload.txt"), "utf8"), "meta-kim");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 4 });
  }
});
