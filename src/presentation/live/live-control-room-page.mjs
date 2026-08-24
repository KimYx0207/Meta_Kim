/**
 * Dependency-free presentation for the Meta_Kim Live control room.
 *
 * The page is deliberately a shell: the browser reads the frozen v1 snapshot
 * from the local API and listens for refresh hints over SSE. Snapshot values
 * are only ever placed into DOM text nodes by the client script. This keeps a
 * compromised or malformed observer payload from becoming executable markup.
 */

export const LIVE_SNAPSHOT_SCHEMA_VERSION = "meta-kim-live-snapshot-v1";

const DEFAULT_SNAPSHOT_ENDPOINT = "/api/snapshot";
const DEFAULT_EVENTS_ENDPOINT = "/api/events";
const DEFAULT_SHARE_ENDPOINT = "/api/share";
const DEFAULT_CONTROL_ENDPOINT = "/api/commands";
const LIVE_CONTROL_ACTIONS = ["pause", "resume", "reassign", "handoff"];
const LIVE_CONTROL_HEADER = "x-meta-kim-control-token";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeEndpoint(value, fallback) {
  if (typeof value !== "string") return fallback;
  const endpoint = value.trim();
  if (
    endpoint.length < 1 ||
    endpoint.length > 512 ||
    !endpoint.startsWith("/") ||
    endpoint.startsWith("//") ||
    /[\u0000-\u001f\u007f]/u.test(endpoint)
  ) {
    return fallback;
  }
  return endpoint;
}

function safeJsonForHtml(value) {
  let serialized = "null";
  try {
    const candidate = value && typeof value === "object" ? value : null;
    serialized = JSON.stringify(candidate) ?? "null";
  } catch {
    serialized = "null";
  }

  // The initial snapshot is inside an inert JSON script element. Escaping the
  // HTML-significant characters makes even a hostile string unable to close
  // that element. The client parses it as JSON and then uses textContent.
  return serialized
    .replaceAll("<", "\\u003C")
    .replaceAll(">", "\\u003E")
    .replaceAll("&", "\\u0026")
    .replaceAll("=", "\\u003D")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function isAvailableCapability(value) {
  if (value === true) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return value.available === true || value.enabled === true;
}

function normalizeControlToken(value) {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 256 ||
    !/^[A-Za-z0-9._~+/=-]+$/u.test(value)
  ) return null;
  return value;
}

function normalizeControlConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const enabled = value.controlEnabled === true || value.enabled === true;
  const capabilities = value.capabilities && typeof value.capabilities === "object"
    ? value.capabilities
    : value.commandCapabilities && typeof value.commandCapabilities === "object"
      ? value.commandCapabilities
      : {};
  const controlHeader = value.controlHeader === LIVE_CONTROL_HEADER ? LIVE_CONTROL_HEADER : null;
  const controlToken = normalizeControlToken(value.controlToken);
  if (!enabled || !controlHeader || !controlToken || !LIVE_CONTROL_ACTIONS.every((action) => isAvailableCapability(capabilities[action]))) return null;
  return {
    controlEnabled: true,
    controlHeader,
    controlToken,
    capabilities: Object.fromEntries(LIVE_CONTROL_ACTIONS.map((action) => [action, { available: true }])),
  };
}

const CLIENT_SCRIPT = String.raw`(() => {
  "use strict";

  const app = document.getElementById("live-app");
  if (!app) return;

  const snapshotEndpoint = app.dataset.snapshotEndpoint || "/api/snapshot";
  const eventsEndpoint = app.dataset.eventsEndpoint || "/api/events";
  const shareEndpoint = app.dataset.shareEndpoint || "/api/share";
  const controlEndpoint = app.dataset.controlEndpoint || "/api/commands";
  const initialElement = document.getElementById("live-initial-snapshot");
  const controlConfigElement = document.getElementById("live-control-config");
  const reducedMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false };

  const connectionLabel = app.querySelector("[data-live-connection]");
  const connectionDot = app.querySelector("[data-live-connection-dot]");
  const stateLabel = app.querySelector("[data-live-state-label]");
  const stateChip = app.querySelector("[data-live-state]");
  const title = app.querySelector("[data-live-run-title]");
  const runId = app.querySelector("[data-live-run-id]");
  const stage = app.querySelector("[data-live-run-stage]");
  const started = app.querySelector("[data-live-run-started]");
  const updated = app.querySelector("[data-live-run-updated]");
  const source = app.querySelector("[data-live-source]");
  const graph = app.querySelector("[data-live-graph]");
  const edgeLayer = app.querySelector("[data-live-edge-layer]");
  const nodeList = app.querySelector("[data-live-node-list]");
  const graphEmpty = app.querySelector("[data-live-graph-empty]");
  const evidenceList = app.querySelector("[data-live-evidence-list]");
  const evidenceCount = app.querySelector("[data-live-evidence-count]");
  const evidenceDrawer = app.querySelector("[data-evidence-drawer]");
  const evidenceToggle = app.querySelector("[data-evidence-toggle]");
  const replayRange = app.querySelector("[data-replay-range]");
  const replayEvents = app.querySelector("[data-replay-events]");
  const replayProgress = app.querySelector("[data-replay-progress]");
  const replayPlay = app.querySelector("[data-replay-play]");
  const replayPlayLabel = app.querySelector("[data-replay-play-label]");
  const replayStatus = app.querySelector("[data-replay-status]");
  const emptyState = app.querySelector("[data-live-empty]");
  const liveRegion = app.querySelector("[data-live-region]");
  const lastUpdate = app.querySelector("[data-live-last-update]");
  const runHero = app.querySelector(".run-hero");
  const runFacts = app.querySelector(".run-facts");
  const workspace = app.querySelector(".workspace-grid");
  const replayPanel = app.querySelector(".replay-panel");
  const shareStatus = app.querySelector("[data-live-share-status]");
  const controlPanel = app.querySelector("[data-live-control-panel]");
  const controlStatus = app.querySelector("[data-live-control-status]");
  const controlError = app.querySelector("[data-live-control-error]");
  const controlResult = app.querySelector("[data-live-control-result]");

  let currentSnapshot = null;
  let currentReplayIndex = 0;
  let replayTimer = null;
  let eventSource = null;
  let abortController = null;
  let controlBusy = false;
  let initialControlConfig = null;

  const statuses = new Set(["live", "stale", "in_doubt"]);
  const nodeStatuses = new Set(["running", "completed", "failed", "blocked", "in_doubt", "queued"]);
  const controlActions = ["pause", "resume", "reassign", "handoff"];

  function capabilityAvailable(value) {
    return value === true || Boolean(value && typeof value === "object" && !Array.isArray(value) && (value.available === true || value.enabled === true));
  }

  function normalizeControlToken(value) {
    if (typeof value !== "string" || value.length < 16 || value.length > 256 || !/^[A-Za-z0-9._~+/=-]+$/u.test(value)) return null;
    return value;
  }

  function normalizeControlConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const enabled = value.controlEnabled === true || value.enabled === true;
    const capabilities = value.capabilities && typeof value.capabilities === "object"
      ? value.capabilities
      : value.commandCapabilities && typeof value.commandCapabilities === "object"
        ? value.commandCapabilities
        : {};
    const controlHeader = value.controlHeader === "x-meta-kim-control-token" ? "x-meta-kim-control-token" : null;
    const controlToken = normalizeControlToken(value.controlToken);
    if (!enabled || !controlHeader || !controlToken || !controlActions.every((action) => capabilityAvailable(capabilities[action]))) return null;
    return { controlEnabled: true, controlHeader, controlToken, capabilities: Object.fromEntries(controlActions.map((action) => [action, { available: true }])) };
  }

  function readEmbeddedControlConfig() {
    const text = controlConfigElement?.textContent?.trim();
    if (!text || text === "null") return null;
    try {
      return normalizeControlConfig(JSON.parse(text));
    } catch {
      return null;
    }
  }

  initialControlConfig = readEmbeddedControlConfig();

  function display(value, fallback) {
    if (value === null || value === undefined || value === "") return fallback || "—";
    const text = String(value).normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
    return text.slice(0, 240) || (fallback || "—");
  }

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function firstValue(record, keys, fallback) {
    if (!record || typeof record !== "object") return fallback;
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null && record[key] !== "") {
        return record[key];
      }
    }
    return fallback;
  }

  function normalizedStatus(value) {
    const status = display(value, "stale").toLowerCase().replace(/[\s-]+/gu, "_");
    if (["active", "in_progress", "running", "started"].includes(status)) return "live";
    if (["unknown", "uncertain"].includes(status)) return "in_doubt";
    return statuses.has(status) ? status : "stale";
  }

  function normalizedNodeStatus(value) {
    const status = display(value, "queued").toLowerCase().replace(/[\s-]+/gu, "_");
    if (["active", "in_progress", "executing", "running"].includes(status)) return "running";
    if (["done", "success", "succeeded", "complete", "completed"].includes(status)) return "completed";
    if (["error", "errored", "failure", "failed"].includes(status)) return "failed";
    if (status === "in_doubt") return "in_doubt";
    if (status === "blocked") return "blocked";
    return nodeStatuses.has(status) ? status : "queued";
  }

  function normalizeSnapshot(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const hasRun = Boolean(input.run && typeof input.run === "object" && !Array.isArray(input.run));
    const runInput = hasRun ? input.run : {};
    const sourceInput = input.source && typeof input.source === "object" ? input.source : {};
    const nodeInput = Array.isArray(input.nodes) ? input.nodes : [];
    const edgeInput = Array.isArray(input.edges) ? input.edges : [];
    const evidenceInput = Array.isArray(input.evidence) ? input.evidence : [];
    const replayInput = Array.isArray(input.replay)
      ? { events: input.replay }
      : input.replay && typeof input.replay === "object"
        ? input.replay
        : {};
    const replayInputEvents = Array.isArray(replayInput.events)
      ? replayInput.events
      : Array.isArray(replayInput.timeline)
        ? replayInput.timeline
        : [];
    const hasControlInput = Object.prototype.hasOwnProperty.call(input, "control") || Object.prototype.hasOwnProperty.call(input, "controls");
    const controlInput = Object.prototype.hasOwnProperty.call(input, "control") ? input.control : input.controls;
    const control = hasControlInput
      ? (normalizeControlConfig(controlInput) || { controlEnabled: false, capabilities: {} })
      : null;

    const nodes = nodeInput.slice(0, 500).map((node, index) => {
      const item = node && typeof node === "object" ? node : {};
      return {
        id: display(firstValue(item, ["id", "nodeId"], "node-" + (index + 1)), "node-" + (index + 1)),
        label: display(firstValue(item, ["label", "title", "name", "nodeId"], "Untitled task"), "Untitled task"),
        status: normalizedNodeStatus(firstValue(item, ["status", "state"], "queued")),
        role: display(firstValue(item, ["roleDisplayName", "role", "ownerRole"], "worker"), "worker"),
        agent: display(firstValue(item, ["agent", "ownerAgent", "owner"], "—"), "—"),
        runtime: display(firstValue(item, ["runtime", "runtimeId", "runtimeInstanceAlias"], "local"), "local"),
        summary: display(firstValue(item, ["summary", "description", "message"], "No task detail available"), "No task detail available"),
        progress: numberOr(firstValue(item, ["progress", "progressPercent"], null), null),
      };
    });

    const edges = edgeInput.slice(0, 1000).map((edge, index) => {
      const item = edge && typeof edge === "object" ? edge : {};
      return {
        id: display(firstValue(item, ["id", "edgeId"], "edge-" + (index + 1)), "edge-" + (index + 1)),
        from: display(firstValue(item, ["from", "source", "sourceId"], ""), ""),
        to: display(firstValue(item, ["to", "target", "targetId"], ""), ""),
        status: normalizedNodeStatus(firstValue(item, ["status", "state"], "queued")),
      };
    }).filter((edge) => edge.from && edge.to);

    const evidence = evidenceInput.slice(0, 500).map((item, index) => {
      const record = item && typeof item === "object" ? item : {};
      return {
        id: display(firstValue(record, ["id", "evidenceId", "ref"], "evidence-" + (index + 1)), "evidence-" + (index + 1)),
        label: display(firstValue(record, ["label", "title", "kind", "type"], "Evidence item"), "Evidence item"),
        status: display(firstValue(record, ["status", "assessment", "state"], "observed"), "observed"),
        detail: display(firstValue(record, ["summary", "detail", "message", "description"], "Observed by the local runtime"), "Observed by the local runtime"),
        nodeId: display(firstValue(record, ["nodeId", "node", "ownerNodeId"], ""), ""),
        at: display(firstValue(record, ["timestamp", "occurredAt", "createdAt"], ""), ""),
      };
    });

    const replay = replayInputEvents.slice(0, 1000).map((item, index) => {
      const record = item && typeof item === "object" ? item : {};
      return {
        id: display(firstValue(record, ["id", "eventId"], "event-" + (index + 1)), "event-" + (index + 1)),
        label: display(firstValue(record, ["label", "title", "message", "type"], "Run event"), "Run event"),
        nodeId: display(firstValue(record, ["nodeId", "node", "taskId"], ""), ""),
        at: display(firstValue(record, ["timestamp", "occurredAt", "at", "time"], ""), ""),
        status: normalizedNodeStatus(firstValue(record, ["status", "state"], "queued")),
      };
    });

    return {
      schemaVersion: display(input.schemaVersion, "unknown"),
      source: display(firstValue(sourceInput, ["label", "name", "kind"], input.source), "local observer"),
      run: hasRun ? {
        id: display(firstValue(runInput, ["id", "runId", "key"], input.runId), "unidentified run"),
        title: display(firstValue(runInput, ["title", "name", "label"], "Live execution"), "Live execution"),
        status: normalizedStatus(firstValue(runInput, ["status", "state", "runStatus"], input.status)),
        stage: display(firstValue(runInput, ["stage", "currentStage", "phase"], "Observing"), "Observing"),
        startedAt: display(firstValue(runInput, ["startedAt", "startTime"], "—"), "—"),
        updatedAt: display(firstValue(runInput, ["updatedAt", "lastUpdatedAt", "observedAt"], "—"), "—"),
      } : null,
      nodes,
      edges,
      evidence,
      replay,
      control,
      permissions: input.permissions && typeof input.permissions === "object" ? input.permissions : {},
    };
  }

  function clearChildren(element) {
    if (!element) return;
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function setText(element, value, fallback) {
    if (element) element.textContent = display(value, fallback);
  }

  function makeElement(tagName, className, value) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = display(value);
    return element;
  }

  function formatTime(value) {
    const text = display(value, "—");
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) {
      try {
        return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
      } catch {
        return text;
      }
    }
    return text;
  }

  function stateCopy(status) {
    if (status === "live") return "Live";
    if (status === "in_doubt") return "In doubt";
    return "Stale";
  }

  function updateConnection(kind, message) {
    if (connectionLabel) connectionLabel.textContent = message;
    if (connectionDot) connectionDot.dataset.connection = kind;
  }

  function updateHeader(snapshot) {
    setText(title, snapshot.run.title, "Live execution");
    setText(runId, snapshot.run.id, "unidentified run");
    setText(stage, snapshot.run.stage, "Observing");
    setText(started, formatTime(snapshot.run.startedAt), "—");
    setText(updated, formatTime(snapshot.run.updatedAt), "—");
    setText(source, snapshot.source, "local observer");
    const status = snapshot.run.status;
    if (stateChip) stateChip.dataset.state = status;
    setText(stateLabel, stateCopy(status), "Stale");
    if (liveRegion) liveRegion.textContent = "Run snapshot updated: " + snapshot.run.title;
    if (lastUpdate) lastUpdate.textContent = "Last observed " + formatTime(snapshot.run.updatedAt);
  }

  function nodeClass(status) {
    return status === "in_doubt" ? "in-doubt" : status;
  }

  function renderGraph(snapshot) {
    clearChildren(nodeList);
    clearChildren(edgeLayer);
    if (!snapshot.nodes.length) {
      if (graphEmpty) graphEmpty.hidden = false;
      return;
    }
    if (graphEmpty) graphEmpty.hidden = true;

    const nodeById = new Map();
    snapshot.nodes.forEach((node, index) => {
      const card = makeElement("article", "node-card node-" + nodeClass(node.status));
      card.dataset.nodeId = node.id;
      card.dataset.status = node.status;
      card.dataset.replayStatus = node.status;
      card.setAttribute("role", "listitem");
      card.tabIndex = 0;
      const top = makeElement("div", "node-card-top");
      const marker = makeElement("span", "node-marker", "");
      marker.setAttribute("aria-hidden", "true");
      top.append(marker, makeElement("span", "node-status", node.status.replaceAll("_", " ")));
      const heading = makeElement("h3", "node-title", node.label);
      const summary = makeElement("p", "node-summary", node.summary);
      const meta = makeElement("div", "node-meta");
      const role = makeElement("span", "node-meta-item", node.role);
      role.title = "Role";
      const agent = makeElement("span", "node-meta-item", node.agent);
      agent.title = "Agent";
      const runtime = makeElement("span", "node-meta-item", node.runtime);
      runtime.title = "Runtime";
      meta.append(role, agent, runtime);
      card.append(top, heading, summary, meta);
      if (node.progress !== null) {
        const progress = makeElement("div", "node-progress");
        const bar = makeElement("span", "node-progress-bar");
        bar.style.width = Math.max(0, Math.min(100, node.progress)) + "%";
        progress.append(bar);
        card.append(progress);
      }
      nodeList.append(card);
      nodeById.set(node.id, card);
      card.style.setProperty("--node-order", String(index));
    });

    // Edges are visual guidance only. Geometry is computed from DOM positions;
    // IDs and labels never become markup or selectors.
    const drawEdges = () => {
      if (!graph || !edgeLayer) return;
      const graphRect = graph.getBoundingClientRect();
      edgeLayer.setAttribute("viewBox", "0 0 " + Math.max(1, graph.clientWidth) + " " + Math.max(1, graph.clientHeight));
      for (const edge of snapshot.edges) {
        const from = nodeById.get(edge.from);
        const to = nodeById.get(edge.to);
        if (!from || !to) continue;
        const fromRect = from.getBoundingClientRect();
        const toRect = to.getBoundingClientRect();
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", String(fromRect.right - graphRect.left));
        line.setAttribute("y1", String(fromRect.top + fromRect.height / 2 - graphRect.top));
        line.setAttribute("x2", String(toRect.left - graphRect.left));
        line.setAttribute("y2", String(toRect.top + toRect.height / 2 - graphRect.top));
        line.setAttribute("class", "edge edge-" + nodeClass(edge.status));
        line.setAttribute("vector-effect", "non-scaling-stroke");
        edgeLayer.append(line);
      }
    };
    if (window.requestAnimationFrame) window.requestAnimationFrame(drawEdges);
    else drawEdges();
  }

  function renderEvidence(snapshot) {
    clearChildren(evidenceList);
    setText(evidenceCount, String(snapshot.evidence.length).padStart(2, "0"), "00");
    if (!snapshot.evidence.length) {
      const empty = makeElement("p", "panel-empty", "No evidence has been observed yet.");
      evidenceList.append(empty);
      return;
    }
    snapshot.evidence.forEach((item) => {
      const entry = makeElement("article", "evidence-item");
      entry.dataset.evidenceId = item.id;
      entry.setAttribute("role", "listitem");
      const top = makeElement("div", "evidence-item-top");
      top.append(makeElement("span", "evidence-kind", item.label), makeElement("time", "evidence-time", formatTime(item.at)));
      const detail = makeElement("p", "evidence-detail", item.detail);
      const status = makeElement("span", "evidence-status evidence-status-" + item.status.toLowerCase().replace(/[^a-z0-9_-]/gu, "-"), item.status);
      entry.append(top, detail, status);
      evidenceList.append(entry);
    });
  }

  function renderReplay(snapshot) {
    const events = snapshot.replay;
    clearChildren(replayEvents);
    const max = Math.max(0, events.length - 1);
    if (replayRange) {
      replayRange.max = String(max);
      replayRange.value = String(Math.min(currentReplayIndex, max));
      replayRange.disabled = events.length < 2;
    }
    if (!events.length) {
      replayEvents.append(makeElement("li", "replay-empty", "No replay events in this snapshot."));
      setText(replayStatus, "Waiting for replay data", "Waiting for replay data");
      return;
    }
    events.forEach((event, index) => {
      const item = makeElement("li", "replay-event");
      item.dataset.replayIndex = String(index);
      const marker = makeElement("span", "replay-event-marker", "");
      marker.setAttribute("aria-hidden", "true");
      item.append(marker, makeElement("span", "replay-event-time", formatTime(event.at)), makeElement("span", "replay-event-label", event.label));
      replayEvents.append(item);
    });
    updateReplayPosition(currentReplayIndex);
  }

  const controlActionLabels = {
    pause: "Pause",
    resume: "Resume",
    reassign: "Reassign",
    handoff: "Handoff",
  };

  function effectiveControlConfig(snapshot) {
    if (!snapshot) return null;
    return snapshot.control || initialControlConfig;
  }

  function setControlMessage(element, message) {
    if (element) element.textContent = message;
  }

  function updateControlBusyState() {
    if (!controlPanel) return;
    controlPanel.setAttribute("aria-busy", String(controlBusy));
    controlPanel.querySelectorAll("[data-live-control-action]").forEach((button) => {
      button.disabled = controlBusy;
    });
  }

  function renderControlPanel(snapshot) {
    if (!controlPanel) return;
    const config = effectiveControlConfig(snapshot);
    const enabled = Boolean(config && config.controlEnabled === true && config.controlHeader === "x-meta-kim-control-token" && normalizeControlToken(config.controlToken) && controlActions.every((action) => config.capabilities?.[action]?.available === true));
    controlPanel.hidden = !enabled;
    if (!enabled) {
      updateControlBusyState();
      return;
    }

    const actions = controlPanel.querySelector("[data-live-control-actions]");
    if (actions) {
      for (const action of controlActions) {
        let button = actions.querySelector("[data-live-control-action=\"" + action + "\"]");
        if (!button) {
          button = document.createElement("button");
          button.type = "button";
          button.className = "replay-button control-button";
          button.dataset.liveControlAction = action;
          button.setAttribute("data-live-control-action", action);
          button.setAttribute("aria-label", controlActionLabels[action] + " run");
          button.textContent = controlActionLabels[action];
          actions.append(button);
        }
        if (button.dataset.controlBound !== "true") {
          button.addEventListener("click", () => requestControl(action));
          button.dataset.controlBound = "true";
        }
      }
    }
    setControlMessage(controlStatus, "Controls are enabled by the local service; every command remains pending verification.");
    setControlMessage(controlError, "");
    setControlMessage(controlResult, "");
    updateControlBusyState();
  }

  async function requestControl(action) {
    if (!currentSnapshot || !controlActions.includes(action) || controlBusy) return;
    const runIdentifier = display(currentSnapshot.run?.id, "");
    const controlConfig = effectiveControlConfig(currentSnapshot);
    if (!runIdentifier || !controlConfig || controlConfig.controlHeader !== "x-meta-kim-control-token" || !normalizeControlToken(controlConfig.controlToken)) return;
    if (typeof window.confirm === "function" && !window.confirm("Confirm " + controlActionLabels[action] + " for this run?")) {
      setControlMessage(controlStatus, "Command cancelled; durable state was not changed.");
      return;
    }
    controlBusy = true;
    setControlMessage(controlError, "");
    setControlMessage(controlResult, "");
    setControlMessage(controlStatus, "Sending " + controlActionLabels[action] + " command…");
    updateControlBusyState();
    const controlRequestMethod = "POST";
    try {
      const controlHeaders = {
        accept: "application/json",
        "content-type": "application/json",
      };
      controlHeaders[controlConfig.controlHeader] = controlConfig.controlToken;
      const response = await fetch(controlEndpoint, {
        method: controlRequestMethod,
        headers: controlHeaders,
        body: JSON.stringify({ action, runId: runIdentifier }),
      });
      if (!response.ok) throw new Error("control request failed");
      const payload = await response.json().catch(() => null);
      if (!payload || typeof payload !== "object") throw new Error("control response unavailable");
      setControlMessage(controlResult, "Command observed by the local endpoint; durable execution still requires verification.");
      setControlMessage(controlStatus, "Command accepted for local handling; no completion claim was made.");
    } catch {
      setControlMessage(controlError, "Command could not be sent; this page did not change durable state.");
      setControlMessage(controlStatus, "Control request unavailable.");
    } finally {
      controlBusy = false;
      updateControlBusyState();
    }
  }

  function setShareStatus(message) {
    setControlMessage(shareStatus, message);
  }

  function shareRequestEndpoint(format = "") {
    const query = [];
    if (currentSnapshot?.run?.id) query.push("runId=" + encodeURIComponent(display(currentSnapshot.run.id, "")));
    if (format) query.push("format=" + encodeURIComponent(format));
    if (!query.length) return shareEndpoint;
    return shareEndpoint + (shareEndpoint.includes("?") ? "&" : "?") + query.join("&");
  }

  async function loadSharePayload() {
    const response = await fetch(shareRequestEndpoint(), { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("share request failed");
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("share response unavailable");
    return payload;
  }

  async function loadShareText(format) {
    const response = await fetch(shareRequestEndpoint(format), { headers: { accept: "text/markdown" } });
    if (!response.ok) throw new Error("share card request failed");
    const value = await response.text();
    if (typeof value !== "string" || !value.trim() || value.length > 200000) throw new Error("share card unavailable");
    return value;
  }

  async function loadShareMarkdown() {
    return loadShareText("markdown");
  }

  async function loadShareReadme() {
    return loadShareText("readme");
  }

  function shareArtifactFrom(payload) {
    const artifact = payload.artifact || payload.shareArtifact || (
      payload.schemaVersion === "meta-kim-live-share-v1" && payload.kind === "live_share_artifact" ? payload : null
    );
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw new Error("share artifact unavailable");
    return artifact;
  }

  async function exportShareJson() {
    setShareStatus("Preparing a local JSON export…");
    try {
      const payload = await loadSharePayload();
      const artifact = shareArtifactFrom(payload);
      const serialized = JSON.stringify(artifact, null, 2);
      if (typeof Blob !== "function" || !window.URL?.createObjectURL) throw new Error("download unavailable");
      const url = window.URL.createObjectURL(new Blob([serialized], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "meta-kim-live-share.json";
      link.setAttribute("aria-label", "Download local share JSON");
      document.body.append(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      setShareStatus("JSON export prepared locally; nothing was uploaded.");
    } catch {
      setShareStatus("JSON export unavailable; the local share endpoint did not provide a safe artifact.");
    }
  }

  async function copyShareValue(kind) {
    setShareStatus("Preparing a local share card…");
    try {
      const value = kind === "pr"
        ? await loadShareMarkdown()
        : await loadShareReadme();
      if (typeof value !== "string" || !value.trim() || value.length > 200000) throw new Error("share text unavailable");
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setShareStatus(kind === "pr" ? "PR card copied locally." : "README embed copied locally.");
    } catch {
      setShareStatus("Share copy unavailable; the local endpoint or clipboard was not ready.");
    }
  }

  function updateReplayPosition(index) {
    if (!currentSnapshot) return;
    const events = currentSnapshot.replay;
    const max = Math.max(0, events.length - 1);
    currentReplayIndex = Math.max(0, Math.min(Number(index) || 0, max));
    if (replayRange) replayRange.value = String(currentReplayIndex);
    if (replayProgress) replayProgress.style.width = (max ? (currentReplayIndex / max) * 100 : 0) + "%";
    if (replayStatus) replayStatus.textContent = events.length
      ? "Event " + (currentReplayIndex + 1) + " of " + events.length + ": " + events[currentReplayIndex].label
      : "Waiting for replay data";
    replayEvents?.querySelectorAll("[data-replay-index]").forEach((element) => {
      const active = Number(element.dataset.replayIndex) === currentReplayIndex;
      element.dataset.active = active ? "true" : "false";
    });
    nodeList?.querySelectorAll("[data-node-id]").forEach((element) => {
      const active = events[currentReplayIndex]?.nodeId && element.dataset.nodeId === events[currentReplayIndex].nodeId;
      element.dataset.replayActive = active ? "true" : "false";
      let replayState = "queued";
      for (const event of events.slice(0, currentReplayIndex + 1)) {
        if (event.nodeId === element.dataset.nodeId) replayState = event.status;
      }
      element.dataset.replayStatus = replayState;
    });
  }

  function stopReplay() {
    if (replayTimer !== null) {
      window.clearInterval(replayTimer);
      replayTimer = null;
    }
    if (replayPlay) replayPlay.dataset.playing = "false";
    if (replayPlayLabel) replayPlayLabel.textContent = "Play";
  }

  function toggleReplay() {
    if (!currentSnapshot || currentSnapshot.replay.length < 2) return;
    if (replayTimer !== null) {
      stopReplay();
      return;
    }
    if (currentReplayIndex >= currentSnapshot.replay.length - 1) updateReplayPosition(0);
    if (replayPlay) replayPlay.dataset.playing = "true";
    if (replayPlayLabel) replayPlayLabel.textContent = "Pause";
    replayTimer = window.setInterval(() => {
      if (!currentSnapshot) return stopReplay();
      if (currentReplayIndex >= currentSnapshot.replay.length - 1) return stopReplay();
      updateReplayPosition(currentReplayIndex + 1);
    }, reducedMotion.matches ? 900 : 600);
  }

  function showEmpty(message) {
    if (emptyState) emptyState.hidden = false;
    for (const element of [runHero, runFacts, workspace, replayPanel]) {
      if (element) element.hidden = true;
    }
    if (message) setText(app.querySelector("[data-live-empty-message]"), message, "Waiting for a run snapshot");
  }

  function hideEmpty() {
    if (emptyState) emptyState.hidden = true;
    for (const element of [runHero, runFacts, workspace, replayPanel]) {
      if (element) element.hidden = false;
    }
  }

  function renderSnapshot(input) {
    const snapshot = normalizeSnapshot(input);
    if (!snapshot) {
      showEmpty("Waiting for a run snapshot");
      updateConnection("stale", "Snapshot unavailable");
      return;
    }
    if (!snapshot.run) {
      currentSnapshot = null;
      showEmpty("No governed run has been observed in this project yet.");
      updateConnection("stale", "No run observed");
      return;
    }
    currentSnapshot = snapshot;
    hideEmpty();
    currentReplayIndex = 0;
    updateHeader(snapshot);
    renderGraph(snapshot);
    renderEvidence(snapshot);
    renderReplay(snapshot);
    renderControlPanel(snapshot);
    updateConnection(snapshot.run.status === "live" ? "live" : "stale", snapshot.run.status === "live" ? "Streaming" : "Snapshot loaded");
  }

  function parseEventData(data) {
    if (typeof data !== "string" || !data.trim()) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  function handleEvent(event) {
    const payload = parseEventData(event?.data);
    if (payload && payload.snapshot && typeof payload.snapshot === "object") {
      renderSnapshot(payload.snapshot);
      return;
    }
    if (payload && payload.run && Array.isArray(payload.nodes)) {
      renderSnapshot(payload);
      return;
    }
    // Events are refresh hints. Fetching the canonical snapshot keeps the
    // control room from treating an incomplete SSE event as authoritative.
    loadSnapshot(true);
  }

  async function loadSnapshot(silent) {
    if (abortController) abortController.abort();
    abortController = new AbortController();
    try {
      const response = await fetch(snapshotEndpoint, {
        headers: { accept: "application/json" },
        signal: abortController.signal,
      });
      if (!response.ok) throw new Error("snapshot request failed");
      const payload = await response.json();
      renderSnapshot(payload);
    } catch (error) {
      if (error?.name === "AbortError") return;
      updateConnection("stale", "Reconnecting");
      if (!silent) showEmpty("The local observer is not serving a snapshot yet.");
    }
  }

  function connectEvents() {
    if (!window.EventSource) {
      updateConnection("stale", "Polling snapshot");
      return;
    }
    try {
      eventSource = new EventSource(eventsEndpoint);
      eventSource.addEventListener("open", () => updateConnection("live", "Streaming"));
      eventSource.addEventListener("snapshot", handleEvent);
      eventSource.addEventListener("event", handleEvent);
      eventSource.addEventListener("message", handleEvent);
      eventSource.addEventListener("error", () => updateConnection("stale", "Reconnecting"));
    } catch {
      updateConnection("stale", "Polling snapshot");
    }
  }

  evidenceToggle?.addEventListener("click", () => {
    const next = evidenceDrawer?.hidden !== false;
    if (evidenceDrawer) evidenceDrawer.hidden = !next;
    evidenceToggle.setAttribute("aria-expanded", String(next));
  });
  replayPlay?.addEventListener("click", toggleReplay);
  app.querySelector("[data-replay-reset]")?.addEventListener("click", () => {
    stopReplay();
    updateReplayPosition(0);
  });
  replayRange?.addEventListener("input", (event) => updateReplayPosition(event.target.value));
  replayRange?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
      window.setTimeout(() => updateReplayPosition(replayRange.value), 0);
    }
  });
  app.querySelector("[data-live-share-export-json]")?.addEventListener("click", exportShareJson);
  app.querySelector("[data-live-share-copy-pr]")?.addEventListener("click", () => copyShareValue("pr"));
  app.querySelector("[data-live-share-copy-readme]")?.addEventListener("click", () => copyShareValue("readme"));

  const snapshotText = initialElement?.textContent?.trim();
  if (snapshotText && snapshotText !== "null") {
    try {
      renderSnapshot(JSON.parse(snapshotText));
    } catch {
      showEmpty("The embedded snapshot could not be read.");
    }
  } else {
    showEmpty("Waiting for a run snapshot");
  }
  loadSnapshot(false);
  connectEvents();

  window.addEventListener("beforeunload", () => {
    stopReplay();
    abortController?.abort();
    if (eventSource) eventSource.close();
  }, { once: true });
})();`;

const PAGE_CSS = String.raw`
:root {
  color-scheme: dark;
  --ink: #eef2ff;
  --muted: #8d99b8;
  --subtle: #596682;
  --line: rgba(155, 169, 205, .16);
  --panel: rgba(14, 19, 34, .84);
  --panel-strong: #11192d;
  --canvas: #070b16;
  --cyan: #55e6d0;
  --blue: #6d8dff;
  --amber: #ffca73;
  --red: #ff7e92;
  --green: #75e5aa;
  --shadow: 0 24px 80px rgba(0, 0, 0, .34);
  font-family: "IBM Plex Sans", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  font-synthesis: none;
}

* { box-sizing: border-box; }
html { min-width: 320px; background: var(--canvas); }
body { min-width: 320px; min-height: 100vh; margin: 0; color: var(--ink); background: radial-gradient(circle at 70% -10%, rgba(57, 90, 172, .2), transparent 34rem), var(--canvas); }
button, input { font: inherit; }
button { cursor: pointer; }
button:focus-visible, [type="range"]:focus-visible, [tabindex]:focus-visible, a:focus-visible { outline: 2px solid var(--cyan); outline-offset: 4px; }
.skip-link { position: fixed; z-index: 20; top: 1rem; left: 1rem; padding: .65rem .9rem; color: var(--canvas); background: var(--cyan); border-radius: .55rem; transform: translateY(-160%); transition: transform .2s ease; }
.skip-link:focus { transform: translateY(0); }
.ambient { position: fixed; inset: 0; z-index: -1; pointer-events: none; opacity: .32; background-image: linear-gradient(rgba(104, 125, 183, .05) 1px, transparent 1px), linear-gradient(90deg, rgba(104, 125, 183, .05) 1px, transparent 1px); background-size: 36px 36px; mask-image: linear-gradient(to bottom, black, transparent 80%); }
.shell { width: min(1500px, 100%); margin: 0 auto; padding: 0 2.2rem 2rem; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 88px; border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: .75rem; }
.brand-mark { display: grid; width: 2rem; height: 2rem; place-items: center; color: var(--canvas); background: linear-gradient(145deg, var(--cyan), #8ad7ff); border-radius: .55rem; box-shadow: 0 0 34px rgba(85, 230, 208, .28); }
.eyebrow, .brand-title { margin: 0; }
.eyebrow { color: var(--muted); font-size: .68rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
.brand-title { margin-top: .15rem; font-size: .95rem; font-weight: 650; letter-spacing: .01em; }
.connection { display: inline-flex; align-items: center; gap: .52rem; color: var(--muted); font-size: .78rem; }
.connection-dot, .status-pulse { width: .48rem; height: .48rem; border-radius: 50%; background: var(--amber); box-shadow: 0 0 0 5px rgba(255, 202, 115, .1); }
.connection-dot[data-connection="live"] { background: var(--cyan); box-shadow: 0 0 0 5px rgba(85, 230, 208, .1); animation: pulse 2.2s ease-in-out infinite; }
.connection-dot[data-connection="stale"] { background: var(--amber); }
.main { padding-top: 2.2rem; }
.run-hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 2rem; padding: 1.25rem 0 2rem; }
.run-hero > * { min-width: 0; }
.kicker { margin: 0 0 .65rem; color: var(--cyan); font-size: .7rem; font-weight: 800; letter-spacing: .2em; text-transform: uppercase; }
.run-title { max-width: 850px; margin: 0; color: var(--ink); font-size: clamp(2rem, 4.7vw, 4.6rem); font-weight: 620; line-height: .98; letter-spacing: -.055em; text-wrap: balance; }
.run-subtitle { display: flex; flex-wrap: wrap; gap: .55rem 1rem; margin: 1rem 0 0; color: var(--muted); font-size: .88rem; }
.run-subtitle span { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.run-subtitle span + span::before { margin-right: 1rem; color: var(--subtle); content: "/"; }
.state-chip { display: inline-flex; align-items: center; gap: .58rem; padding: .62rem .82rem; color: var(--amber); background: rgba(255, 202, 115, .08); border: 1px solid rgba(255, 202, 115, .26); border-radius: 999px; font-size: .78rem; font-weight: 720; white-space: nowrap; }
.state-chip[data-state="live"] { color: var(--cyan); background: rgba(85, 230, 208, .08); border-color: rgba(85, 230, 208, .26); }
.state-chip[data-state="in_doubt"] { color: var(--red); background: rgba(255, 126, 146, .08); border-color: rgba(255, 126, 146, .26); }
.state-chip[data-state="live"] .status-pulse { background: var(--cyan); box-shadow: 0 0 0 5px rgba(85, 230, 208, .1); animation: pulse 2.2s ease-in-out infinite; }
.state-chip[data-state="in_doubt"] .status-pulse { background: var(--red); box-shadow: 0 0 0 5px rgba(255, 126, 146, .1); }
.run-facts { display: grid; grid-template-columns: repeat(4, minmax(115px, 1fr)); gap: .55rem; margin: 0; padding: 0; }
.run-fact { min-width: 0; padding: .8rem .9rem; background: rgba(14, 19, 34, .6); border: 1px solid var(--line); border-radius: .7rem; }
.run-fact dt { margin-bottom: .35rem; color: var(--subtle); font-size: .63rem; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
.run-fact dd { margin: 0; overflow: hidden; color: var(--muted); font-size: .78rem; text-overflow: ellipsis; white-space: nowrap; }
.workspace-grid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(280px, .7fr); align-items: start; gap: 1rem; }
.panel { position: relative; min-width: 0; background: linear-gradient(150deg, rgba(22, 29, 51, .88), rgba(10, 14, 27, .9)); border: 1px solid var(--line); border-radius: 1.1rem; box-shadow: var(--shadow); }
.panel-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1.05rem 1.15rem; border-bottom: 1px solid var(--line); }
.panel-title { margin: 0; color: var(--ink); font-size: .92rem; font-weight: 700; letter-spacing: -.01em; }
.panel-note { margin: .35rem 0 0; color: var(--subtle); font-size: .72rem; }
.panel-count { color: var(--cyan); font-family: "SFMono-Regular", Consolas, monospace; font-size: .72rem; }
.graph-stage { position: relative; min-height: 470px; overflow: hidden; padding: 1.1rem; }
.edge-layer { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.edge { stroke: rgba(109, 141, 255, .32); stroke-width: 1.4; stroke-dasharray: 5 7; }
.edge-running { stroke: var(--cyan); stroke-dasharray: 1 7; animation: dash 1.5s linear infinite; }
.edge-completed { stroke: rgba(117, 229, 170, .48); }
.node-list { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(2, minmax(180px, 1fr)); gap: .7rem; }
.node-card { min-width: 0; padding: .85rem; background: rgba(18, 25, 45, .94); border: 1px solid rgba(140, 159, 207, .16); border-radius: .8rem; box-shadow: 0 10px 30px rgba(0, 0, 0, .15); transition: border-color .2s ease, transform .2s ease, background .2s ease; }
.node-card:hover, .node-card:focus-visible { background: rgba(25, 36, 63, .98); border-color: rgba(85, 230, 208, .42); transform: translateY(-2px); }
.node-card[data-replay-active="true"] { border-color: var(--cyan); box-shadow: 0 0 0 1px rgba(85, 230, 208, .25), 0 14px 40px rgba(45, 214, 192, .12); }
.node-card[data-replay-status="completed"] { border-left-color: var(--green); }
.node-card[data-replay-status="failed"], .node-card[data-replay-status="in_doubt"] { border-left-color: var(--red); }
.node-card[data-replay-status="running"] { border-left-color: var(--cyan); }
.node-card-top, .evidence-item-top { display: flex; align-items: center; justify-content: space-between; gap: .6rem; }
.node-marker { display: inline-block; width: .48rem; height: .48rem; margin-right: .38rem; border-radius: 50%; background: var(--subtle); vertical-align: middle; }
.node-status { color: var(--muted); font-size: .63rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.node-running .node-marker { background: var(--cyan); box-shadow: 0 0 13px rgba(85, 230, 208, .8); animation: pulse 1.6s ease-in-out infinite; }
.node-completed .node-marker { background: var(--green); }
.node-failed .node-marker, .node-in-doubt .node-marker { background: var(--red); }
.node-blocked .node-marker { background: var(--amber); }
.node-title { margin: .7rem 0 .35rem; overflow: hidden; color: var(--ink); font-size: .94rem; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }
.node-summary { min-height: 2.45em; margin: 0; overflow: hidden; color: var(--muted); font-size: .73rem; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.node-meta { display: flex; flex-wrap: wrap; gap: .3rem; margin-top: .85rem; }
.node-meta-item { max-width: 100%; padding: .25rem .42rem; overflow: hidden; color: var(--subtle); background: rgba(5, 9, 18, .42); border-radius: .35rem; font-family: "SFMono-Regular", Consolas, monospace; font-size: .61rem; text-overflow: ellipsis; white-space: nowrap; }
.node-progress { height: 3px; margin-top: .8rem; overflow: hidden; background: rgba(141, 153, 184, .15); border-radius: 4px; }
.node-progress-bar { display: block; height: 100%; background: linear-gradient(90deg, var(--blue), var(--cyan)); border-radius: inherit; transition: width .45s ease; }
.graph-empty, .panel-empty, .replay-empty { color: var(--subtle); font-size: .8rem; }
.graph-empty { position: absolute; inset: 0; display: grid; place-items: center; padding: 2rem; text-align: center; }
.evidence-panel { overflow: hidden; }
.drawer-toggle, .replay-button { display: inline-flex; align-items: center; gap: .45rem; color: var(--muted); background: transparent; border: 1px solid var(--line); border-radius: .55rem; font-size: .73rem; }
.drawer-toggle { padding: .45rem .6rem; }
.drawer-toggle:hover, .replay-button:hover { color: var(--ink); border-color: rgba(85, 230, 208, .45); }
.evidence-drawer { max-height: 530px; overflow: auto; padding: .65rem; }
.evidence-list { display: grid; gap: .5rem; margin: 0; }
.evidence-item { padding: .75rem; background: rgba(7, 11, 22, .44); border: 1px solid rgba(140, 159, 207, .11); border-radius: .7rem; }
.evidence-kind { color: var(--ink); font-size: .75rem; font-weight: 650; }
.evidence-time { color: var(--subtle); font-family: "SFMono-Regular", Consolas, monospace; font-size: .62rem; }
.evidence-detail { margin: .55rem 0; color: var(--muted); font-size: .72rem; line-height: 1.45; }
.evidence-status { display: inline-block; padding: .24rem .42rem; color: var(--cyan); background: rgba(85, 230, 208, .08); border-radius: .32rem; font-size: .62rem; font-weight: 700; }
.evidence-status-in\ doubt, .evidence-status-rejected { color: var(--red); background: rgba(255, 126, 146, .08); }
.replay-panel { margin-top: 1rem; }
.replay-controls { display: flex; align-items: center; gap: .55rem; }
.replay-button { padding: .44rem .62rem; }
.replay-button[data-playing="true"] { color: var(--cyan); border-color: rgba(85, 230, 208, .4); }
.replay-range-wrap { display: grid; gap: .5rem; padding: 1rem 1.15rem .3rem; }
.replay-range { width: 100%; accent-color: var(--cyan); }
.replay-track { position: relative; height: 3px; background: rgba(141, 153, 184, .15); border-radius: 99px; }
.replay-progress { position: absolute; inset: 0 auto 0 0; width: 0; background: linear-gradient(90deg, var(--blue), var(--cyan)); border-radius: inherit; }
.replay-events { display: flex; gap: .8rem; margin: 0; padding: 1rem 1.15rem 1.15rem; overflow-x: auto; list-style: none; }
.replay-event { display: grid; grid-template-columns: auto auto; gap: .2rem .45rem; min-width: 145px; padding: .6rem .68rem; color: var(--muted); background: rgba(7, 11, 22, .42); border: 1px solid var(--line); border-radius: .6rem; }
.replay-event[data-active="true"] { color: var(--ink); border-color: rgba(85, 230, 208, .46); background: rgba(85, 230, 208, .08); }
.replay-event-marker { grid-row: span 2; align-self: center; width: .48rem; height: .48rem; border-radius: 50%; background: var(--subtle); }
.replay-event[data-active="true"] .replay-event-marker { background: var(--cyan); box-shadow: 0 0 10px rgba(85, 230, 208, .7); }
.replay-event-time { color: var(--subtle); font-family: "SFMono-Regular", Consolas, monospace; font-size: .6rem; }
.replay-event-label { overflow: hidden; font-size: .7rem; text-overflow: ellipsis; white-space: nowrap; }
.replay-status { margin: 0; color: var(--muted); font-size: .72rem; }
.share-panel, .control-panel { margin-top: 1rem; }
.share-content, .control-content { padding: 1rem 1.15rem 1.15rem; }
.share-actions, .control-actions { display: flex; flex-wrap: wrap; gap: .55rem; }
.share-status, .control-status, .control-result, .control-error { margin: .8rem 0 0; color: var(--muted); font-size: .72rem; line-height: 1.45; }
.control-result { color: var(--cyan); }
.control-error { color: var(--red); }
.control-button:disabled { cursor: wait; opacity: .55; }
.control-panel[hidden] { display: none; }
.empty-state { margin-top: 1rem; padding: 2.4rem; text-align: center; background: rgba(14, 19, 34, .72); border: 1px dashed rgba(141, 153, 184, .25); border-radius: 1rem; }
.empty-state[hidden], .graph-empty[hidden], .evidence-drawer[hidden] { display: none; }
.empty-glyph { display: inline-grid; width: 2.3rem; height: 2.3rem; place-items: center; margin-bottom: .8rem; color: var(--cyan); background: rgba(85, 230, 208, .1); border-radius: .7rem; }
.empty-title { margin: 0; font-size: 1rem; }
.empty-copy { max-width: 36rem; margin: .5rem auto 0; color: var(--muted); font-size: .8rem; line-height: 1.5; }
.footer { display: flex; justify-content: space-between; gap: 1rem; padding: 1.2rem 0 0; color: var(--subtle); font-size: .68rem; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@keyframes pulse { 0%, 100% { opacity: .55; transform: scale(.85); } 50% { opacity: 1; transform: scale(1.15); } }
@keyframes dash { to { stroke-dashoffset: -16; } }
@media (max-width: 980px) { .run-hero { grid-template-columns: 1fr; gap: 1.2rem; } .run-facts { max-width: 700px; } .workspace-grid { grid-template-columns: 1fr; } .evidence-drawer { max-height: 360px; } }
@media (max-width: 620px) { .shell { padding: 0 1rem 1.4rem; } .topbar { min-height: 72px; } .connection [data-live-connection] { display: none; } .run-title { font-size: clamp(2.25rem, 13vw, 4rem); } .run-subtitle span { flex-basis: 100%; } .run-subtitle span + span::before { display: none; } .run-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); } .node-list { grid-template-columns: 1fr; } .graph-stage { min-height: 360px; padding: .75rem; } .panel-header { padding: .9rem; } .replay-events, .replay-range-wrap { padding-left: .9rem; padding-right: .9rem; } .footer { flex-direction: column; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; } }
`;

export function renderLiveControlRoomPage({
  snapshot = null,
  snapshotEndpoint = DEFAULT_SNAPSHOT_ENDPOINT,
  eventsEndpoint = DEFAULT_EVENTS_ENDPOINT,
  shareEndpoint = DEFAULT_SHARE_ENDPOINT,
  controlEndpoint = DEFAULT_CONTROL_ENDPOINT,
  controlEnabled = false,
  commandCapabilities = null,
  controlHeader = null,
  controlToken = null,
} = {}) {
  const safeSnapshotEndpoint = normalizeEndpoint(snapshotEndpoint, DEFAULT_SNAPSHOT_ENDPOINT);
  const safeEventsEndpoint = normalizeEndpoint(eventsEndpoint, DEFAULT_EVENTS_ENDPOINT);
  const safeShareEndpoint = normalizeEndpoint(shareEndpoint, DEFAULT_SHARE_ENDPOINT);
  const safeControlEndpoint = normalizeEndpoint(controlEndpoint, DEFAULT_CONTROL_ENDPOINT);
  const hasSnapshotControl = Boolean(snapshot && typeof snapshot === "object" && (Object.prototype.hasOwnProperty.call(snapshot, "control") || Object.prototype.hasOwnProperty.call(snapshot, "controls")));
  const snapshotControl = hasSnapshotControl ? normalizeControlConfig(snapshot.control ?? snapshot.controls) : null;
  const configuredControl = normalizeControlConfig({ controlEnabled, commandCapabilities, controlHeader, controlToken });
  const safeControlConfig = hasSnapshotControl ? snapshotControl : configuredControl;
  const initialJson = safeJsonForHtml(snapshot);
  const controlConfigJson = safeJsonForHtml(safeControlConfig);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#070b16">
  <meta name="description" content="Meta_Kim Live read-only execution control room">
  <link rel="icon" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAzMiAzMic+PHJlY3Qgd2lkdGg9JzMyJyBoZWlnaHQ9JzMyJyByeD0nOCcgZmlsbD0nIzA3MGIxNicvPjxwYXRoIGQ9J004IDIyVjEwaDRsNCA1IDQtNWg0djEyaC00di02bC00IDUtNC01djZ6JyBmaWxsPScjNmVlN2ZmJy8+PC9zdmc+">
  <title>Meta_Kim Live · Control room</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <a class="skip-link" id="skip-to-content" href="#live-main">Skip to content</a>
  <div class="ambient" aria-hidden="true"></div>
  <div id="live-app" class="shell" data-snapshot-endpoint="${escapeHtml(safeSnapshotEndpoint)}" data-events-endpoint="${escapeHtml(safeEventsEndpoint)}" data-share-endpoint="${escapeHtml(safeShareEndpoint)}" data-control-endpoint="${escapeHtml(safeControlEndpoint)}">
    <header class="topbar" aria-label="Meta_Kim Live header">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">✦</span>
        <div><p class="eyebrow">Meta_Kim / Live</p><p class="brand-title">Control room</p></div>
      </div>
      <div class="connection" aria-live="polite"><span class="connection-dot" data-live-connection-dot aria-hidden="true"></span><span data-live-connection>Connecting…</span></div>
    </header>
    <main class="main" id="live-main" tabindex="-1">
      <section class="run-hero" aria-labelledby="run-title">
        <div>
          <p class="kicker">Observed execution</p>
          <h1 class="run-title" id="run-title" data-live-run-title>Waiting for a run snapshot</h1>
          <p class="run-subtitle"><span data-live-run-id>unidentified run</span><span data-live-source>local observer</span><span data-live-run-stage>Observing</span></p>
        </div>
        <div class="state-chip" data-live-state data-state="stale"><span class="status-pulse" aria-hidden="true"></span><span data-live-state-label>Stale</span></div>
      </section>
      <dl class="run-facts" aria-label="Run facts">
        <div class="run-fact"><dt>Started</dt><dd data-live-run-started>—</dd></div>
        <div class="run-fact"><dt>Last update</dt><dd data-live-run-updated>—</dd></div>
        <div class="run-fact"><dt>Surface</dt><dd>Read-only</dd></div>
        <div class="run-fact"><dt>Schema</dt><dd>Frozen v1</dd></div>
      </dl>
      <div class="sr-only" data-live-region aria-live="polite"></div>
      <section class="workspace-grid" aria-label="Live execution workspace">
        <section class="panel graph-panel" aria-labelledby="graph-title">
          <header class="panel-header"><div><h2 class="panel-title" id="graph-title">Execution graph</h2><p class="panel-note">Tasks move from evidence to verified state.</p></div><span class="panel-count">DAG / READ-ONLY</span></header>
          <div class="graph-stage" data-live-graph role="region" aria-label="Read-only execution graph">
            <svg class="edge-layer" data-live-edge-layer aria-hidden="true" focusable="false"></svg>
            <div class="node-list" data-live-node-list role="list" aria-label="Execution nodes"></div>
            <div class="graph-empty" data-live-graph-empty hidden><p>No task nodes in this snapshot.</p></div>
          </div>
        </section>
        <aside class="panel evidence-panel" aria-labelledby="evidence-title">
          <header class="panel-header"><div><h2 class="panel-title" id="evidence-title">Evidence</h2><p class="panel-note">What the observer can substantiate.</p></div><div class="replay-controls"><span class="panel-count" data-live-evidence-count>00</span><button class="drawer-toggle" type="button" data-evidence-toggle aria-controls="evidence-drawer" aria-expanded="true" aria-label="Toggle evidence drawer">Details</button></div></header>
          <div class="evidence-drawer" id="evidence-drawer" data-evidence-drawer><div class="evidence-list" data-live-evidence-list role="list" aria-label="Observed evidence"></div></div>
        </aside>
      </section>
      <section class="panel replay-panel" aria-labelledby="replay-title">
        <header class="panel-header"><div><h2 class="panel-title" id="replay-title">Replay timeline</h2><p class="panel-note" data-replay-status>Waiting for replay data</p></div><div class="replay-controls"><button class="replay-button" type="button" data-replay-play aria-label="Play replay"><span aria-hidden="true">▶</span><span data-replay-play-label>Play</span></button><button class="replay-button" type="button" data-replay-reset aria-label="Reset replay">Reset</button></div></header>
        <div class="replay-range-wrap"><label class="sr-only" for="replay-range">Replay position</label><input class="replay-range" id="replay-range" data-replay-range type="range" min="0" max="0" value="0" step="1" aria-label="Replay position" disabled><div class="replay-track" data-replay-track aria-hidden="true"><span class="replay-progress" data-replay-progress></span></div></div>
        <ol class="replay-events" data-replay-events data-replay-timeline aria-label="Replay events"></ol>
      </section>
      <section class="panel share-panel" aria-labelledby="share-title">
        <header class="panel-header"><div><h2 class="panel-title" id="share-title">Share locally</h2><p class="panel-note">No upload, no external assets, no mutation.</p></div><span class="panel-count">LOCAL ONLY</span></header>
        <div class="share-content"><div class="share-actions"><button class="replay-button share-button" type="button" data-live-share-export-json>Export JSON</button><button class="replay-button share-button" type="button" data-live-share-copy-pr>Copy PR card</button><button class="replay-button share-button" type="button" data-live-share-copy-readme>README embed</button></div><p class="share-status" id="meta-kim-live-share-status" data-live-share-status role="status" aria-live="polite">Share actions stay local and require the local /api/share endpoint.</p></div>
      </section>
      <section class="panel control-panel" data-live-control-panel aria-labelledby="control-title" aria-busy="false"${safeControlConfig ? "" : " hidden"}>
        <header class="panel-header"><div><h2 class="panel-title" id="control-title">Continuation controls</h2><p class="panel-note">Opt-in commands require explicit local capabilities and durable verification.</p></div><span class="panel-count">AUTHORITY-BOUND</span></header>
        <div class="control-content"><div class="control-actions" data-live-control-actions>${safeControlConfig ? LIVE_CONTROL_ACTIONS.map((action) => `<button class="replay-button control-button" type="button" data-live-control-action="${action}" aria-label="${action[0].toUpperCase() + action.slice(1)} run">${action[0].toUpperCase() + action.slice(1)}</button>`).join("") : ""}</div><p class="control-status" data-live-control-status role="status" aria-live="polite">Controls are read-only until the local service declares every action available.</p><p class="control-result" data-live-control-result role="status" aria-live="polite"></p><p class="control-error" data-live-control-error role="alert" aria-live="assertive"></p></div>
      </section>
      <section class="empty-state" data-live-empty hidden aria-labelledby="empty-title"><span class="empty-glyph" aria-hidden="true">◌</span><h2 class="empty-title" id="empty-title">No live snapshot yet</h2><p class="empty-copy" data-live-empty-message>Waiting for the local observer to publish a frozen v1 snapshot.</p></section>
    </main>
    <footer class="footer"><span>Local observer · <span data-live-last-update>Last observed —</span></span><span>Read-only surface · no run mutations</span></footer>
  </div>
  <script type="application/json" id="live-initial-snapshot">${initialJson}</script>
  <script type="application/json" id="live-control-config">${controlConfigJson}</script>
  <script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}

export const buildLiveControlRoomPage = renderLiveControlRoomPage;
export const renderLivePage = renderLiveControlRoomPage;
