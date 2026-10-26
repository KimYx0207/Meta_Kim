import { LIVE_FEEDBACK_COPY } from "./live-feedback-copy.mjs";

/** Build a local handoff without altering the user's feedback or claiming delivery. */
export function buildLocalFeedbackText(context, original, language = "zh") {
  const copy = LIVE_FEEDBACK_COPY[language === "zh" ? "zh" : "en"];
  const lines = [copy.instruction];
  if (context.projectId) lines.push(copy.project + context.projectId);
  lines.push(copy.run + context.runId);
  if (context.feedbackId) lines.push(copy.feedback + context.feedbackId);
  if (context.findingId) lines.push(copy.finding + context.findingId);
  if (context.taskPacketId) lines.push(copy.taskReference + context.taskPacketId);
  if (context.nodeId) lines.push(copy.node + (context.nodeLabel ? context.nodeLabel + " · " : "") + context.nodeId);
  if (context.deliverableId) lines.push(copy.deliverable + context.deliverableId + (context.deliverableLabel ? " · " + context.deliverableLabel : ""));
  if (context.deliverableId) lines.push(copy.version + (/^sha256:[a-f0-9]{64}$/u.test(context.contentVersion || "") ? context.contentVersion : copy.unknownVersion));
  if (context.evidenceId) lines.push(copy.evidence + context.evidenceId);
  if (context.sourceRef) lines.push(copy.source + context.sourceRef);
  lines.push("", copy.original, original);
  return lines.join("\n");
}

/** Persist exact local drafts per target; storage failure never discards in-memory input. */
export function createLocalFeedbackDraftStore(options = {}) {
  const drafts = new Map();
  const versions = new Map();
  const bindings = new Map();
  const persistence = new Map();
  const corrupt = new Set();
  const selections = new Map();
  const prefix = "meta-kim.live.feedback.v1:";
  let storage;
  try { storage = options.storage ?? globalThis.localStorage; } catch { storage = null; }
  const createId = options.createId || (() => globalThis.crypto?.randomUUID?.()
    || "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/gu, (value) => { const n = Math.floor(Math.random() * 16); return (value === "x" ? n : (n & 3) | 8).toString(16); }));
  const validIdentity = (value, kind) => typeof value === "string" && new RegExp("^" + kind + ":[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$", "u").test(value);
  const baseKey = (context) => JSON.stringify([context.projectId || "", context.runId || "", context.nodeId || ""]);
  const targetKey = (context) => JSON.stringify([baseKey(context), context.deliverableId || "", context.evidenceId || ""]);
  const version = (context) => /^sha256:[a-f0-9]{64}$/u.test(context.contentVersion || "") ? context.contentVersion : "unknown";
  const key = (context) => JSON.stringify([targetKey(context), version(context)]);
  function persist(id) {
    if (corrupt.has(id)) return;
    try {
      if (typeof storage?.setItem !== "function") throw new Error("unavailable");
      storage.setItem(prefix + id, JSON.stringify({ schemaVersion: 1, targetKey: id, ...drafts.get(id), ...bindings.get(id), contentVersion: versions.get(id) }));
      persistence.set(id, { state: "saved", reason: null });
    } catch { persistence.set(id, { state: "memory_only", reason: "storage_unavailable" }); }
  }
  function get(context) {
    const id = targetKey(context);
    if (!drafts.has(id)) {
      drafts.set(id, { original: "", prepared: "" });
      bindings.set(id, { feedbackId: "feedback:" + createId(), findingId: "finding:" + createId() });
      versions.set(id, version(context));
      persistence.set(id, { state: "memory_only", reason: "not_saved" });
      try {
        const raw = storage?.getItem(prefix + id);
        if (raw !== null && raw !== undefined) {
          const stored = JSON.parse(raw);
          if (stored?.schemaVersion !== 1 || stored.targetKey !== id || typeof stored.original !== "string" || typeof stored.prepared !== "string"
            || !validIdentity(stored.feedbackId, "feedback") || !validIdentity(stored.findingId, "finding")
            || !(stored.contentVersion === "unknown" || /^sha256:[a-f0-9]{64}$/u.test(stored.contentVersion))) throw new Error("corrupt");
          drafts.set(id, { original: stored.original, prepared: stored.prepared });
          bindings.set(id, { feedbackId: stored.feedbackId, findingId: stored.findingId });
          versions.set(id, stored.contentVersion);
          persistence.set(id, { state: "saved", reason: null });
        }
      } catch {
        corrupt.add(id);
        persistence.set(id, { state: "memory_only", reason: "corrupt_storage" });
      }
    }
    if (versions.get(id) !== version(context)) {
      drafts.get(id).prepared = "";
      versions.set(id, version(context));
      persist(id);
    }
    return drafts.get(id);
  }
  return {
    get,
    update(context, change) {
      const draft = get(context);
      for (const field of ["original", "prepared"]) if (typeof change[field] === "string") draft[field] = change[field];
      persist(targetKey(context));
      return draft;
    },
    binding(context) { get(context); return { ...bindings.get(targetKey(context)) }; },
    persistence(context) { get(context); return { ...persistence.get(targetKey(context)) }; },
    matching(context, items) {
      const draft = get(context);
      const binding = bindings.get(targetKey(context));
      return (Array.isArray(items) ? items : []).filter((item) => {
        if (item?.runId !== context.runId || (draft.original.trim() && (item.feedbackId !== binding.feedbackId || item.findingRef !== binding.findingId))) return false;
        if (context.nodeId && (!context.taskPacketId || ![item.taskPacketId, item.sourceTaskPacketId].includes(context.taskPacketId))) return false;
        if (context.evidenceId && item.feedbackId !== binding.feedbackId) return false;
        if (!context.deliverableId) return true;
        const expectedVersion = version(context);
        if (expectedVersion === "unknown") return false;
        return (item.deliverableId === context.deliverableId && item.contentVersion === expectedVersion)
          || (item.sourceDeliverableId === context.deliverableId && item.sourceContentVersion === expectedVersion);
      });
    },
    selected(context) {
      const id = baseKey(context);
      if (!selections.has(id)) {
        try {
          const value = JSON.parse(storage?.getItem(prefix + "selection:" + id) || "null");
          selections.set(id, value?.baseKey === id && typeof value.value === "string" ? value.value : "");
        } catch { selections.set(id, ""); }
      }
      return selections.get(id);
    },
    select(context, value) {
      const id = baseKey(context);
      selections.set(id, value);
      try { storage?.setItem(prefix + "selection:" + id, JSON.stringify({ baseKey: id, value })); } catch {}
    },
    key,
  };
}

/** Accept only a same-run opaque descriptor; never expose a supplied URL or path. */
export function normalizeLiveDeliverables(input, runId) {
  if (!Array.isArray(input) || !runId) return [];
  const identifier = (value) => typeof value === "string" && value.trim().length > 0
    && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value) ? value.normalize("NFKC").trim() : "";
  const seen = new Set();
  return input.slice(0, 256).flatMap((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return [];
    const id = identifier(record.id);
    if (!id || seen.has(id) || identifier(record.runId) !== runId
      || !["text", "markdown", "html", "external"].includes(record.kind)
      || !["available", "declared"].includes(record.availability)) return [];
    seen.add(id);
    return [{ id, runId, taskPacketId: identifier(record.taskPacketId) || null,
      label: typeof record.label === "string" ? record.label.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 240) || id : id,
      kind: record.kind, availability: record.availability,
      contentVersion: /^sha256:[a-f0-9]{64}$/u.test(record.contentVersion || "") ? record.contentVersion : null }];
  });
}

/** Task association is an explicit binding, never a label or node-id guess. */
export function liveDeliverablesForNode(deliverables, node) {
  if (!node) return deliverables || [];
  return node.taskPacketId ? (deliverables || []).filter((item) => item.taskPacketId === node.taskPacketId) : [];
}

/** Ship the tested definitions into the dependency-free Live page. */
export function serializeLocalFeedbackResolvers() {
  const copyResource = "const LIVE_FEEDBACK_COPY = " + JSON.stringify(LIVE_FEEDBACK_COPY).replace(/</gu, "\\u003c") + ";\n";
  return copyResource + [buildLocalFeedbackText, createLocalFeedbackDraftStore, normalizeLiveDeliverables, liveDeliverablesForNode]
    .map((resolver) => resolver.toString()).join("\n");
}
