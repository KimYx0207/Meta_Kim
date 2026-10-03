import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const routeScript = fileURLToPath(new URL("./select-execution-route.mjs", import.meta.url));

export function runRouteQuery({ task, runtime = "auto", os = "auto", extraArgs = [], env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        routeScript,
        "--task",
        task,
        "--runtime",
        runtime,
        "--os",
        os,
        "--json",
        ...extraArgs,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            stderr || stdout ||
              `Route query exited ${code ?? "unknown"}${signal ? ` after ${signal}` : ""}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Route query returned invalid JSON: ${error.message}`));
      }
    });
  });
}
