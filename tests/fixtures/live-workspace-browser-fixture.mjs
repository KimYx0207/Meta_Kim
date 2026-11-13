/** Deterministic acceptance data, never evidence of a model or native host run. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInitialState, activateSpineState } from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { joinProjectRegistry } from "../../scripts/project-registry.mjs";
import { startLiveControlRoom } from "../../src/infrastructure/live/live-control-room-server.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const option = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const projectRoot = path.resolve(option("--project-root"));
const registryRoot = path.resolve(option("--registry-root"));
const action = option("--action");
const requestedLocale = option("--locale");
const fixtureCopy = JSON.parse(await readFile(new URL("./live-workspace-browser-copy.json", import.meta.url), "utf8"));
const copyFor = locale => {
  assert.ok(Object.hasOwn(fixtureCopy.locales, locale), `Unsupported fixture locale: ${locale}`);
  return fixtureCopy.locales[locale];
};
if (requestedLocale !== undefined) copyFor(requestedLocale);
const metadataPath = path.join(projectRoot, ".meta-kim/work/browser-fixture.json");
const inputPath = path.join(projectRoot, ".meta-kim/work/design-input.json");
const digest = value => createHash("sha256").update(value).digest("hex");
const execute = (fixture, args) => {
  const result = spawnSync(process.execPath, [path.join(repo, "scripts/live-workspace-host.mjs"),
    "--project-root", projectRoot, "--profile", "default", "--run-id", fixture.runId,
    "--conversation-id", fixture.conversationId, ...args], { cwd: repo, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

if (action === "init") {
  const locale = requestedLocale || "zh";
  const copy = copyFor(locale);
  await mkdir(path.join(projectRoot, ".git"), { recursive: true });
  await mkdir(path.join(projectRoot, ".meta-kim/work"), { recursive: true });
  await mkdir(path.join(projectRoot, "outputs"), { recursive: true });
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "live-workspace-acceptance-fixture", private: true }));
  const conversationId = "01900000-0000-7000-8000-000000000092";
  const state = createInitialState({ activationMode: "hook_observed", driverMode: "hook_observed", hookGateMode: "advisory",
    sourceConversation: { runtime: "codex", conversationId, matchBasis: "transcript_file_verified" } });
  state.recordOrigin = "acceptance_fixture";
  state.currentStage = "thinking";
  state.stages.critical.status = "completed";
  state.stages.fetch.status = "completed";
  state.stages.thinking.status = "in_progress";
  state.publicSummary = copy.publicSummary;
  await activateSpineState(projectRoot, state);
  const moduleDefinitions = [
    { id: "alpha", ...copy.modules.alpha },
    { id: "beta", ...copy.modules.beta, dependsOn: ["alpha"] },
    { id: "gamma", ...copy.modules.gamma, dependsOn: ["beta"] },
    { id: "delta", ...copy.modules.delta, dependsOn: ["gamma"] },
  ];
  const outlineCopy = copy.outline;
  const outline = [
    `# ${outlineCopy.heading}`, "",
    `> ${outlineCopy.notice}`, "",
    `## ${outlineCopy.goalHeading}`, outlineCopy.goalBody, "",
    `## ${outlineCopy.modulesHeading}`, ...moduleDefinitions.map(item => `- ${item.title}${outlineCopy.moduleSeparator}${item.purpose}`), "",
    `## ${outlineCopy.interactionHeading}`, outlineCopy.interactionBody, "",
    `## ${outlineCopy.dataHeading}`, outlineCopy.dataBody, "",
    `## ${outlineCopy.criteriaHeading}`, outlineCopy.criteriaBody, "",
    ...Array.from({ length: 150 }, (_, index) => `### ${outlineCopy.itemHeading.replace("{number}", String(index + 1))}\n${outlineCopy.itemBody}\n`),
    `## ${outlineCopy.endHeading}`, outlineCopy.endBody, "",
  ].join("\n");
  await writeFile(path.join(projectRoot, "outputs/outline.md"), outline);
  const input = { schemaVersion: 1, design: { mode: "exploration", userJourneys: [], interfaces: [], sharedState: [], taskSlices: [], settledDecisionRefs: [],
    softwareDesign: { schemaVersion: 1, architecture: { id: "collaboration-workspace", ...copy.architecture, revision: 1,
      decisionRefs: [], technologyChoices: [], constraints: [],
      moduleIds: moduleDefinitions.map(item => item.id) }, modules: moduleDefinitions } },
    materialRefs: { outline: "outputs/outline.md", modules: {} } };
  await writeFile(inputPath, JSON.stringify(input, null, 2));
  const fixture = { projectRoot, runId: state.runId, conversationId, locale,
    outlineHeading: copy.outline.heading, moduleHeading: copy.alpha.heading, recordOrigin: "acceptance_fixture",
    modelCalled: false, nativeInvocationVerified: false, completionVerified: false, outlineSha256: digest(outline), outlineBytes: Buffer.byteLength(outline) };
  execute(fixture, ["--publish-design", "--input", inputPath, "--expected-revision", "0"]);
  const registration = await joinProjectRegistry({ homeDir: registryRoot, repoPath: projectRoot });
  fixture.projectId = registration.projectRef;
  await writeFile(metadataPath, JSON.stringify(fixture, null, 2));
  console.log(JSON.stringify(fixture));
} else if (action === "serve") {
  const live = await startLiveControlRoom({ globalHub: true, homeDir: registryRoot, port: 0 });
  console.log(JSON.stringify({ url: live.url, globalHub: true, fixture: true }));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, async () => { await live.close(); process.exit(0); });
} else {
  const fixture = JSON.parse(await readFile(metadataPath, "utf8"));
  const locale = fixture.locale || "zh";
  assert.ok(requestedLocale === undefined || requestedLocale === locale, "Fixture locale must match its persisted metadata");
  const copy = copyFor(locale);
  const inspect = () => execute(fixture, ["--inspect"]);
  if (action === "inspect") console.log(JSON.stringify(inspect()));
  else if (action === "advance") {
    const before = inspect();
    assert.equal(before.nextAction.kind, "design_module");
    assert.equal(before.nextAction.moduleId, "alpha");
    const claim = execute(fixture, ["--claim-request", "--command-id", before.nextAction.commandId, "--expected-revision", String(before.revision)]);
    const input = JSON.parse(await readFile(inputPath, "utf8"));
    const text = `# ${copy.alpha.heading}\n\n${copy.alpha.sections.map(section => `## ${section.heading}\n${section.body}`).join("\n\n")}\n`;
    await writeFile(path.join(projectRoot, "outputs/alpha.md"), text);
    Object.assign(input.design.softwareDesign.modules[0], { implementationNotes: copy.alpha.implementationNotes,
      businessRules: copy.alpha.businessRules,
      states: [{ name: "pending", behavior: copy.alpha.pendingBehavior }, { name: "ready", behavior: copy.alpha.readyBehavior }] });
    input.materialRefs.modules.alpha = "outputs/alpha.md";
    await writeFile(inputPath, JSON.stringify(input, null, 2));
    execute(fixture, ["--publish-design", "--input", inputPath, "--expected-revision", String(inspect().revision)]);
    const receipt = path.join(projectRoot, ".meta-kim/work/receipt.json");
    await writeFile(receipt, JSON.stringify({ outcome: "produced", summary: copy.alpha.receiptSummary,
      evidenceRefs: [{ ref: "outputs/alpha.md", sha256: digest(text) }] }));
    const result = execute(fixture, ["--complete-request", "--command-id", claim.commandId, "--claim-token", claim.claimToken,
      "--input", receipt, "--expected-revision", String(inspect().revision)]);
    assert.equal(result.status, "host_reported");
    assert.equal(result.completionVerified, false);
    console.log(JSON.stringify(result));
  } else throw new Error("Unsupported fixture action");
}
