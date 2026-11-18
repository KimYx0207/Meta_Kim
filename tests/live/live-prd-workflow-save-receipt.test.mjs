import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";

import { createLiveWorkspaceController, LIVE_WORKSPACE_UI_POLICY } from "../../src/presentation/live/live-workspace-client.mjs";
import {
  LIVE_WORKSPACE_MESSAGES, workspaceArtifactItems, workspaceCommandMessage, workspaceMaterialIdentity,
  workspaceMaterialMatches, workspaceMaterialReady,
} from "../../src/presentation/live/live-workspace-model.mjs";
import { createDynamicPrdWorkflowCanvas } from "../../src/presentation/live/live-prd-workflow-canvas.mjs";

const token = "private-agent-token-123456789";
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
async function settled() { for (let i = 0; i < 10; i += 1) await setImmediate(); }

function uiNode(tag = "div") {
  return { tagName: tag.toUpperCase(), hidden: false, disabled: false, dataset: {}, attributes: {}, value: "", textContent: "", children: [],
    addEventListener() {}, setAttribute(name, value) { this.attributes[name] = String(value); },
    appendChild(child) { this.children.push(child); return child; }, append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; }, focus() {} };
}

// Runs the real browser controller in a vm with a fake unified desktop that
// captures the callbacks the PRD canvas would call.
function harness(prdWorkflowReply) {
  let desktopArgs = null;
  const win = { location: { origin: "http://127.0.0.1:4331", href: "http://127.0.0.1:4331/" }, history: { replaceState() {} },
    crypto: { randomUUID: () => "random-1" }, sessionStorage: { getItem() {}, setItem() {}, removeItem() {} },
    setInterval: () => 1, clearInterval() {}, setTimeout: (fn, delay) => setTimeout(fn, delay), clearTimeout,
    fetch: async (url) => (new URL(url).pathname === "/api/agent/prd-workflow"
      ? prdWorkflowReply()
      : reply({ schemaVersion: "meta-kim-agent-hosts-v1", executionAllowed: false, hosts: [] })),
  };
  const doc = { defaultView: win, visibilityState: "visible", addEventListener() {}, removeEventListener() {}, createElement: (tag) => uiNode(tag) };
  const root = { ownerDocument: doc, dataset: {}, querySelector: () => null, querySelectorAll: () => [] };
  const app = { querySelector: (selector) => selector === "[data-uw-workspace]" ? root : null, querySelectorAll: () => [] };
  const context = vm.createContext({ URL, AbortController, TextEncoder, Date, LIVE_WORKSPACE_MESSAGES, workspaceArtifactItems,
    workspaceMaterialIdentity, workspaceMaterialMatches, workspaceMaterialReady, workspaceCommandMessage,
    createLiveWorkspaceRenderer: () => ({ render() {}, renderMain() {}, detailCloseButton: null, content: { scrollTop: 0, focus() {} } }),
    createDynamicPrdWorkflowCanvas, buildLivePrdGraph: () => ({ nodes: [], edges: [] }), createPrdKnowledgeGraph: () => null,
    translateAgentUi: (value) => value,
    createUnifiedAgentDesktop: (args) => { desktopArgs = args; return new Proxy({}, { get: () => () => undefined }); },
    options: { app, policy: LIVE_WORKSPACE_UI_POLICY, config: { enabled: true, agentEntryEnabled: true, controlHeader: "x-meta-kim-workspace-token", controlToken: token },
      language: () => "zh", showLegacyView() {}, openProjects() {}, openGraph() {} },
  });
  const controller = vm.runInContext("(" + createLiveWorkspaceController.toString() + ")(options)", context);
  assert.ok(desktopArgs, "the controller must create the unified desktop with callbacks");
  return { controller, desktopArgs };
}

const baselineBlueprint = { kind: "project_architecture_baseline" };

test("PRD canvas save treats an HTTP 200 with the wrong schema as a failure and shows it", async (t) => {
  const h = harness(() => reply({ status: "ok", nodes: [] }));
  t.after(() => h.controller.dispose());
  await settled();
  const { state, callbacks } = h.desktopArgs;
  const before = state.prdWorkflowCanvas;

  const saved = await callbacks.mutatePrdWorkflow({ action: "reset_baseline" }, baselineBlueprint);
  assert.equal(saved, false);
  assert.equal(state.prdWorkflowCanvas, before, "a malformed receipt must not replace the canvas");
  assert.match(state.prdWorkflowError, /保存未生效/u);
  assert.equal(state.prdWorkflowBusy, false);

  const fakeDoc = { createElement: (tag) => uiNode(tag), createElementNS: (_ns, tag) => uiNode(tag) };
  const view = createDynamicPrdWorkflowCanvas({ doc: fakeDoc, workflow: null, blueprint: { design: { modules: [] } }, errorMessage: state.prdWorkflowError });
  const find = (node) => node?.dataset?.uwWfError ? node : (node?.children || []).map(find).find(Boolean);
  const alert = find(view);
  assert.ok(alert, "the canvas must render the save error");
  assert.equal(alert.attributes.role, "alert");
});

test("PRD canvas save accepts only the authoritative canvas schema and clears the error", async (t) => {
  let schemaVersion = "wrong";
  const h = harness(() => reply({ schemaVersion, revision: 2, nodes: [], edges: [] }));
  t.after(() => h.controller.dispose());
  await settled();
  const { state, callbacks } = h.desktopArgs;
  assert.equal(await callbacks.mutatePrdWorkflow({ action: "reset_baseline" }, baselineBlueprint), false);
  assert.notEqual(state.prdWorkflowError, "");

  schemaVersion = "meta-kim-prd-workflow-canvas-v1";
  assert.equal(await callbacks.mutatePrdWorkflow({ action: "reset_baseline" }, baselineBlueprint), true);
  assert.equal(state.prdWorkflowCanvas.revision, 2);
  assert.equal(state.prdWorkflowError, "");
});
