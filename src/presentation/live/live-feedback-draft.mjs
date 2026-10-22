/** Build a local handoff without altering the user's feedback or claiming delivery. */
export function buildLocalFeedbackText(context, original, language = "zh") {
  const zh = language === "zh";
  const lines = [zh
    ? "请依据下面的反馈局部修订当前结果，保留已确认需求及不相关改动；修订后复查同一结果。"
    : "Revise this result using the feedback below, preserve confirmed requirements and unrelated work, then check the same result again.",
  ];
  if (context.projectId) lines.push((zh ? "项目：" : "Project: ") + context.projectId);
  lines.push((zh ? "运行：" : "Run: ") + context.runId);
  if (context.nodeId) lines.push((zh ? "节点：" : "Node: ") + (context.nodeLabel ? context.nodeLabel + " · " : "") + context.nodeId);
  if (context.deliverableId) lines.push((zh ? "交付物：" : "Deliverable: ") + context.deliverableId + (context.deliverableLabel ? " · " + context.deliverableLabel : ""));
  if (context.deliverableId) lines.push((zh ? "本次读取版本：" : "Version read this time: ") + (/^sha256:[a-f0-9]{64}$/u.test(context.contentVersion || "") ? context.contentVersion : zh ? "未知（尚未取得内容哈希）" : "unknown (content hash not obtained)"));
  if (context.evidenceId) lines.push((zh ? "证据：" : "Evidence: ") + context.evidenceId);
  if (context.sourceRef) lines.push((zh ? "可见来源引用：" : "Visible source reference: ") + context.sourceRef);
  lines.push("", zh ? "用户反馈原话：" : "User feedback, verbatim:", original);
  return lines.join("\n");
}

/** Keep independent drafts in this page only; no remote write or implied queue. */
export function createLocalFeedbackDraftStore() {
  const drafts = new Map();
  const versions = new Map();
  const selections = new Map();
  const baseKey = (context) => JSON.stringify([context.projectId || "", context.runId || "", context.nodeId || ""]);
  const targetKey = (context) => JSON.stringify([baseKey(context), context.deliverableId || "", context.evidenceId || ""]);
  const version = (context) => /^sha256:[a-f0-9]{64}$/u.test(context.contentVersion || "") ? context.contentVersion : "unknown";
  const key = (context) => JSON.stringify([targetKey(context), version(context)]);
  return {
    get(context) {
      const id = targetKey(context);
      if (!drafts.has(id)) drafts.set(id, { original: "", prepared: "" });
      if (versions.has(id) && versions.get(id) !== version(context)) drafts.get(id).prepared = "";
      versions.set(id, version(context));
      return drafts.get(id);
    },
    selected(context) { return selections.get(baseKey(context)) || ""; },
    select(context, value) { selections.set(baseKey(context), value); },
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
  return [buildLocalFeedbackText, createLocalFeedbackDraftStore, normalizeLiveDeliverables, liveDeliverablesForNode]
    .map((resolver) => resolver.toString()).join("\n");
}
