import { containsReadOnlyRunSensitiveMaterial } from "../../domain/presentation/read-only-run-projection-schema.mjs";

const COPY_FIELDS = ["title", "runLabel", "statusLabel", "stageLabel", "projectionStatusLabel", "completedColumnLabel", "pendingColumnLabel", "blockedColumnLabel", "inDoubtColumnLabel"];

function fail(message) { throw new TypeError(`Invalid read-only run surface: ${message}`); }
function plain(value) { return value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).every((key) => typeof key === "string") && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => descriptor.enumerable === true && "value" in descriptor); }
function exact(value, fields, label) { if (!plain(value) || Object.keys(value).sort().join("|") !== [...fields].sort().join("|")) fail(`${label} must contain exact own data fields`); return value; }
function text(value, label) { const normalized = typeof value === "string" ? value.normalize("NFKC") : value; if (typeof normalized !== "string" || normalized.length < 1 || normalized.length > 160 || /[<>\u0000-\u001f]/u.test(normalized) || containsReadOnlyRunSensitiveMaterial(normalized)) fail(`${label} must be bounded display copy`); return normalized; }
function escapeHtml(value) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }
function normalizeStatusColumnMap(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) fail("statusColumnMap must be a bounded dense array");
  const result = new Map();
  for (const [index, item] of value.entries()) {
    exact(item, ["status", "columnId"], `statusColumnMap[${index}]`);
    const status = text(item.status, `statusColumnMap[${index}].status`);
    if (!["completed", "pending", "blocked", "in_doubt"].includes(item.columnId) || result.has(status)) fail("statusColumnMap entries must be unique and target a known column");
    result.set(status, item.columnId);
  }
  return result;
}

export function renderReadOnlyRunSurfaces({ model, copy, statusColumnMap }) {
  exact(copy, COPY_FIELDS, "copy");
  const labels = Object.fromEntries(COPY_FIELDS.map((field) => [field, text(copy[field], `copy.${field}`)]));
  const columnByStatus = normalizeStatusColumnMap(statusColumnMap);
  const rows = model.semantic.nodeStates.map((node) => ({ nodeId: node.nodeId, status: node.status }));
  if (rows.some((row) => !columnByStatus.has(row.status))) fail("every node status must have a configured column");
  const header = { runId: model.semantic.runId, runStatus: model.semantic.runStatus, projectionStatus: model.status, currentStage: model.semantic.currentStage, durableCursor: model.semantic.durableCursor, headCheckpointId: model.semantic.headCheckpointId, projectionStates: model.semantic.projectionStates.map((item) => ({ ...item })), semanticDigest: model.semanticDigest };
  const columns = [
    ["completed", labels.completedColumnLabel], ["pending", labels.pendingColumnLabel],
    ["blocked", labels.blockedColumnLabel], ["in_doubt", labels.inDoubtColumnLabel],
  ].map(([columnId, label]) => ({ columnId, label, cards: rows.filter((row) => columnByStatus.get(row.status) === columnId).map((row) => ({ ...row })) }));
  const markdownRows = rows.length > 0 ? rows.map((row) => `- ${row.nodeId}: ${row.status}`).join("\n") : "-";
  const htmlRows = rows.map((row) => `<li data-status="${escapeHtml(row.status)}">${escapeHtml(row.nodeId)}: ${escapeHtml(row.status)}</li>`).join("");
  return deepFreeze({
    nativePanel: { ...header, title: labels.title, rows },
    kanban: { ...header, title: labels.title, columns },
    markdown: { ...header, content: `# ${labels.title}\n\n${labels.runLabel}: ${header.runId}\n\n${labels.statusLabel}: ${header.runStatus}\n\n${labels.projectionStatusLabel}: ${header.projectionStatus}\n\n${labels.stageLabel}: ${header.currentStage}\n\n${markdownRows}` },
    html: { ...header, content: `<section data-run-projection="read-only" data-projection-status="${escapeHtml(header.projectionStatus)}" data-semantic-digest="${escapeHtml(header.semanticDigest)}"><h1>${escapeHtml(labels.title)}</h1><p>${escapeHtml(labels.runLabel)}: ${escapeHtml(header.runId)}</p><p>${escapeHtml(labels.statusLabel)}: ${escapeHtml(header.runStatus)}</p><p>${escapeHtml(labels.projectionStatusLabel)}: ${escapeHtml(header.projectionStatus)}</p><p>${escapeHtml(labels.stageLabel)}: ${escapeHtml(header.currentStage)}</p><ul>${htmlRows}</ul></section>` },
  });
}

export const READ_ONLY_RUN_SURFACE_COPY_FIELDS = Object.freeze(COPY_FIELDS);
