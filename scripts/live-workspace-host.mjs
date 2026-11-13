#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createLiveWorkspaceService } from "../src/application/live/live-workspace-service.mjs";

/** Current-host pull port: it never starts a provider process or spends quota. */
export async function runLiveWorkspaceHost(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    "project-root": { type: "string" }, profile: { type: "string", default: "default" },
    "run-id": { type: "string" }, "conversation-id": { type: "string" }, "expected-revision": { type: "string" },
    input: { type: "string" }, "command-id": { type: "string" }, "claim-token": { type: "string" },
    "artifact-id": { type: "string" }, version: { type: "string" }, cursor: { type: "string" }, "read-material": { type: "boolean" },
    inspect: { type: "boolean" }, "list-requests": { type: "boolean" }, "publish-design": { type: "boolean" }, "claim-request": { type: "boolean" }, "complete-request": { type: "boolean" },
    help: { type: "boolean" },
  }, strict: true });
  if (values.help) return { usage: "node scripts/live-workspace-host.mjs --project-root ROOT --profile PROFILE --run-id RUN --conversation-id CHAT [--inspect | --list-requests [--cursor CURSOR | --command-id ID] | --publish-design --input PROJECT_JSON --expected-revision N | --read-material --artifact-id ID --version SHA256_VERSION [--cursor CURSOR] | --claim-request --command-id ID --expected-revision N | --complete-request --command-id ID --claim-token TOKEN --input RECEIPT_JSON --expected-revision N]",
    boundary: "Use the exact bound profile; no profile fallback is attempted. Inspect reports request totals, truncation and next-page arguments. List requests is a bounded, revision-bound history page, not proof feedback was applied. Actual current-host scope and existing spine CAS are required. Claims and reports never imply native model invocation or business completion." };
  if (typeof values["project-root"] !== "string" || !path.isAbsolute(values["project-root"])) throw new Error("workspace_project_root_required");
  if (["inspect", "list-requests", "publish-design", "claim-request", "complete-request", "read-material"].filter(key => values[key]).length !== 1) throw new Error("workspace_one_host_operation_required");
  const service = createLiveWorkspaceService({ projectRoot: values["project-root"], profile: values.profile });
  const command = { runId: values["run-id"], conversationId: values["conversation-id"],
    expectedRevision: /^\d+$/u.test(values["expected-revision"] || "") ? Number(values["expected-revision"]) : undefined,
    commandId: values["command-id"], claimToken: values["claim-token"] };
  if (values.inspect) return service.hostInspect(command);
  if (values["list-requests"]) {
    await service.hostInspect(command);
    return service.getRequests({ runId: command.runId, cursor: values.cursor, commandId: command.commandId });
  }
  if (values["read-material"]) {
    await service.hostInspect(command);
    return service.getMaterial({ runId: command.runId, artifactId: values["artifact-id"], version: values.version, cursor: values.cursor });
  }
  if (values["publish-design"] || values["complete-request"]) {
    if (!values.input) throw new Error("workspace_input_required");
    const relative = path.relative(service.repository.projectRoot, path.resolve(service.repository.projectRoot, values.input)).split(path.sep).join("/");
    if (!relative.startsWith(".meta-kim/work/") || relative.split("/").includes("..")) throw new Error("workspace_input_requires_project_work_file");
    command.input = await service.repository.readJson(relative);
  }
  if (values["publish-design"]) return service.publishDesign(command);
  if (values["claim-request"]) return service.claimRequest(command);
  return service.completeRequest(command);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await runLiveWorkspaceHost(), null, 2) + "\n"); }
  catch (error) { process.stderr.write(JSON.stringify({ status: "blocked", code: error.code || "workspace_host_invalid", message: error.code || error.message,
    completionVerified: false, nativeInvocationVerified: false }) + "\n"); process.exitCode = 1; }
}
