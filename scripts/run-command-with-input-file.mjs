import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const specPath = process.argv[2];
if (!specPath || !path.isAbsolute(specPath)) {
  throw new Error("An absolute invocation spec path is required.");
}

const spec = JSON.parse(await fs.readFile(specPath, "utf8"));
if (
  typeof spec?.file !== "string" ||
  spec.file.trim().length === 0 ||
  !Array.isArray(spec?.args) ||
  !spec.args.every((value) => typeof value === "string") ||
  typeof spec?.cwd !== "string" ||
  !path.isAbsolute(spec.cwd) ||
  typeof spec?.inputFile !== "string" ||
  !path.isAbsolute(spec.inputFile)
) {
  throw new Error("Invocation spec is invalid.");
}

const input = await fs.readFile(spec.inputFile);
const child = spawn(spec.file, spec.args, {
  cwd: spec.cwd,
  env: process.env,
  windowsHide: true,
  stdio: ["pipe", "inherit", "inherit"],
});

child.stdin.on("error", (error) => {
  if (error?.code !== "EPIPE") throw error;
});
child.stdin.end(input);

const outcome = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

if (outcome.signal) {
  process.stderr.write(`Child terminated by signal ${outcome.signal}.\n`);
  process.exitCode = 1;
} else {
  process.exitCode = Number.isInteger(outcome.code) ? outcome.code : 1;
}
