/**
 * Which project and which run the control room opens on by default.
 *
 * The graph is the default view, so the first thing a reader sees is whatever
 * this ordering chose. It was choosing a run with nothing in it. Measured on the
 * running hub: the bare root URL landed on a session with zero task nodes, only
 * 21 of 114 catalogued sessions had any nodes, and the project that sorted first
 * carried 0 substantive sessions out of 17 while another carried 29 out of 44.
 *
 * The data was never missing. Both sorts simply compared liveness first, so an
 * activation receipt written seconds ago outranked every run that had produced
 * output. Recency and liveness are real signals, but they answer "what happened
 * last", not "what is there to look at", and a default view has to answer the
 * second question before the first.
 *
 * Drawability is therefore its own rank term, ahead of liveness, and it reads
 * the two facts the catalog already publishes: a measured `nodeCount` when a
 * governed artifact declared its collections, and `substanceClass` otherwise.
 * `normalizeLiveDefaultSelectionPolicy` rejects a rank order that puts liveness
 * or recency ahead of drawability, which makes the measured defect
 * unconfigurable rather than merely discouraged, and it requires every rank key
 * and every drawability class to be present so the fix cannot be disabled by
 * leaving a line out.
 *
 * The row builders, the comparator and the picker are exported as functions and
 * serialized into the browser bundle by their own `toString()`. The client script
 * is inlined into a page string and cannot import this module, and a second copy
 * of the ordering in the page would be free to disagree with the copy the hub
 * serves and the tests exercise.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LIVE_RECORD_ORIGINS } from "./live-record-origin.mjs";

export const LIVE_DEFAULT_SELECTION_SCHEMA_VERSION = "meta-kim-live-default-selection-v1";

export const LIVE_DEFAULT_SELECTION_CONFIG_URL = new URL(
  "../../../config/live/default-selection.json",
  import.meta.url,
);

/**
 * Drawability classes in descending order of "there is something on screen".
 *
 * `measured_empty` sits above `activation_only` because a run that wrote a
 * governed artifact declaring no nodes at least has a report to read, while an
 * activation receipt has neither.
 */
export const LIVE_DRAWABILITY_CLASSES = Object.freeze([
  "measured_nodes",
  "substantive",
  "unknown",
  "measured_empty",
  "activation_only",
]);

export const LIVE_SELECTION_RANK_KEYS = Object.freeze([
  "provenance",
  "drawability",
  "identified",
  "active",
  "recency",
  "commitment",
  "identity",
]);

function fail(message, code = "LIVE_DEFAULT_SELECTION_INVALID") {
  const error = new TypeError(`Live default selection: ${message}`);
  error.code = code;
  throw error;
}

/**
 * Validate one descending weight map against its declared class order.
 *
 * Both weight maps fail the same two ways: a class with no weight falls through
 * to whatever the next rank term says, and an equal or inverted pair lets the
 * worse class win. One implementation keeps a later map from being added with
 * only half of those checks.
 */
function normalizeOrderedRankMap(raw, field, classes, notOrderedMessage) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${field} must be an object`);
  if (Object.keys(raw).length !== classes.length || classes.some((name) => !Number.isFinite(raw[name]))) {
    fail(
      `${field} must carry a finite weight for each of ${classes.join(", ")} and nothing else, otherwise an `
        + "unweighted class falls through to whatever the next term says",
      "LIVE_DEFAULT_SELECTION_RANK_INCOMPLETE",
    );
  }
  const rank = Object.freeze(Object.fromEntries(classes.map((name) => [name, raw[name]])));
  for (let index = 1; index < classes.length; index += 1) {
    const above = classes[index - 1];
    const below = classes[index];
    if (!(rank[above] > rank[below])) {
      fail(
        `${above} must weigh more than ${below}; ${notOrderedMessage}`,
        "LIVE_DEFAULT_SELECTION_RANK_NOT_ORDERED",
      );
    }
  }
  return rank;
}

/** Validate and freeze a raw default-selection document. */
export function normalizeLiveDefaultSelectionPolicy(raw) {
  if (!raw || typeof raw !== "object") fail("document must be an object");
  if (raw.schemaVersion !== LIVE_DEFAULT_SELECTION_SCHEMA_VERSION) {
    fail(
      `schemaVersion must be ${LIVE_DEFAULT_SELECTION_SCHEMA_VERSION}`,
      "LIVE_DEFAULT_SELECTION_SCHEMA_MISMATCH",
    );
  }
  if (!Array.isArray(raw.rankOrder)) fail("rankOrder must be an array");
  const rankOrder = Object.freeze([...raw.rankOrder]);
  const declared = new Set(rankOrder);
  if (declared.size !== rankOrder.length || declared.size !== LIVE_SELECTION_RANK_KEYS.length
    || LIVE_SELECTION_RANK_KEYS.some((key) => !declared.has(key))) {
    fail(
      `rankOrder must list each of ${LIVE_SELECTION_RANK_KEYS.join(", ")} exactly once, otherwise an omitted `
        + "comparison is silently never applied",
      "LIVE_DEFAULT_SELECTION_RANK_ORDER_INCOMPLETE",
    );
  }
  if (rankOrder[rankOrder.length - 1] !== "identity") {
    fail(
      "identity must be the last rank key, because it is the only total tie-break and anything after it is unreachable",
      "LIVE_DEFAULT_SELECTION_IDENTITY_NOT_LAST",
    );
  }
  const provenanceIndex = rankOrder.indexOf("provenance");
  for (const key of ["drawability", "identified", "active", "recency", "commitment"]) {
    if (rankOrder.indexOf(key) < provenanceIndex) {
      fail(
        `${key} must not outrank provenance: an acceptance fixture carries the node collections and resolved `
          + "runtime a real activation often lacks, so any term ahead of provenance lets a fixture be presented "
          + "as the project's best real run",
        "LIVE_DEFAULT_SELECTION_PROVENANCE_OUTRANKED",
      );
    }
  }
  const drawabilityIndex = rankOrder.indexOf("drawability");
  for (const key of ["identified", "active", "recency"]) {
    if (rankOrder.indexOf(key) < drawabilityIndex) {
      fail(
        `${key} must not outrank drawability: that ordering is what opened the control room on a run with zero `
          + "task nodes while runs with a drawable graph sat further down the list",
        "LIVE_DEFAULT_SELECTION_DRAWABILITY_OUTRANKED",
      );
    }
  }
  const drawabilityRank = normalizeOrderedRankMap(
    raw.drawabilityRank,
    "drawabilityRank",
    LIVE_DRAWABILITY_CLASSES,
    "equal or inverted weights let a run with nothing to draw be chosen over one that has nodes",
  );
  const provenanceRank = normalizeOrderedRankMap(
    raw.provenanceRank,
    "provenanceRank",
    LIVE_RECORD_ORIGINS,
    "equal or inverted weights let a fixture be chosen over a real governed run",
  );
  return Object.freeze({ schemaVersion: raw.schemaVersion, rankOrder, drawabilityRank, provenanceRank });
}

/** Read and validate the shipped default-selection document. */
export function loadLiveDefaultSelectionPolicy(configUrl = LIVE_DEFAULT_SELECTION_CONFIG_URL) {
  const filePath = fileURLToPath(configUrl);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`cannot read ${filePath}: ${error.message}`, "LIVE_DEFAULT_SELECTION_UNREADABLE");
  }
  return normalizeLiveDefaultSelectionPolicy(parsed);
}

/**
 * How much of a run there is to look at.
 *
 * A measured count is believed over a derived class in both directions: a
 * governed artifact that declared zero nodes is proof there is nothing to draw,
 * even when the run is otherwise substantive.
 *
 * Self-contained on purpose: this function's own source is inlined into the
 * browser bundle, so it may not close over anything in this module.
 */
export function resolveDrawabilityClass(session) {
  if (!session || typeof session !== "object") return "unknown";
  if (Number.isFinite(session.nodeCount)) return session.nodeCount > 0 ? "measured_nodes" : "measured_empty";
  if (session.substanceClass === "substantive") return "substantive";
  if (session.substanceClass === "activation_only") return "activation_only";
  return "unknown";
}

/**
 * The minimum a default choice needs from a catalog session.
 *
 * `extra.committedRank` exists because commitment is a property of the records a
 * run left behind, not of the session projection, and only the catalog reader has
 * those records in hand. Also inlined into the browser bundle.
 */
export function sessionSelectionRow(session, extra = {}) {
  const committed = Number.isFinite(extra?.committedRank) ? extra.committedRank : session?.committedRank;
  return {
    identity: typeof session?.runId === "string" ? session.runId : "",
    drawabilityClass: resolveDrawabilityClass(session),
    recordOrigin: typeof session?.recordOrigin === "string" ? session.recordOrigin : "governed_run",
    active: session?.active === true,
    identified: extra?.identified === undefined ? session?.identified === true : extra.identified === true,
    updatedAt: typeof session?.updatedAt === "string" ? session.updatedAt : "",
    commitmentRank: Number.isFinite(committed) ? committed : 0,
    session,
  };
}

/**
 * The same row for a project, whose drawability is the best of its sessions: one
 * run worth opening is enough to make the project worth opening. Provenance
 * follows the same "best of" rule, so one real run keeps a project that also
 * holds fixtures ahead of a project that holds nothing but fixtures. Also inlined.
 */
export function projectSelectionRow(project, policy) {
  const sessions = Array.isArray(project?.sessions) ? project.sessions : [];
  // Seeded from the first session rather than from a placeholder: seeding with
  // "unknown" would report a project whose every session is an activation
  // receipt as merely unclassified, which is a better rank than the truth.
  let best = null;
  let bestOrigin = null;
  for (const session of sessions) {
    const candidate = resolveDrawabilityClass(session);
    if (best === null || policy.drawabilityRank[candidate] > policy.drawabilityRank[best]) best = candidate;
    const declared = typeof session?.recordOrigin === "string" ? session.recordOrigin : "governed_run";
    const origin = policy.provenanceRank[declared] === undefined ? "governed_run" : declared;
    if (bestOrigin === null || policy.provenanceRank[origin] > policy.provenanceRank[bestOrigin]) bestOrigin = origin;
  }
  return {
    identity: typeof project?.projectId === "string" ? project.projectId : "",
    drawabilityClass: best === null ? "unknown" : best,
    recordOrigin: bestOrigin === null ? "governed_run" : bestOrigin,
    active: project?.status === "active" || project?.status === "live"
      || sessions.some((session) => session?.active === true),
    // Best-of, like drawability and provenance: one run worth naming is enough to
    // keep the project ahead of one holding nothing but unnamed records.
    identified: sessions.some((session) => session?.identified === true),
    updatedAt: typeof project?.updatedAt === "string" ? project.updatedAt : "",
    commitmentRank: sessions.length,
    project,
  };
}

/**
 * Order two selection rows by the configured rank keys. Also inlined, so it
 * reads only fields the row builders put there.
 */
export function compareSelectionRows(left, right, policy) {
  for (const key of policy.rankOrder) {
    let delta = 0;
    if (key === "provenance") {
      // An origin the policy does not weigh is ranked as a governed run rather
      // than given a rank of its own, so a record cannot promote or demote
      // itself by declaring a value nobody registered.
      const leftWeight = policy.provenanceRank[left.recordOrigin] === undefined
        ? policy.provenanceRank.governed_run
        : policy.provenanceRank[left.recordOrigin];
      const rightWeight = policy.provenanceRank[right.recordOrigin] === undefined
        ? policy.provenanceRank.governed_run
        : policy.provenanceRank[right.recordOrigin];
      delta = rightWeight - leftWeight;
    } else if (key === "drawability") {
      delta = policy.drawabilityRank[right.drawabilityClass] - policy.drawabilityRank[left.drawabilityClass];
    } else if (key === "active") {
      delta = Number(right.active === true) - Number(left.active === true);
    } else if (key === "identified") {
      // Whether a run is identified is a judgement about its title and its linked
      // conversation, which only the surface rendering those has. The row builder
      // takes it as supplied rather than deriving it, exactly like commitment.
      delta = Number(right.identified === true) - Number(left.identified === true);
    } else if (key === "recency") {
      delta = String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
    } else if (key === "commitment") {
      delta = Number(right.commitmentRank || 0) - Number(left.commitmentRank || 0);
    } else {
      delta = String(left.identity || "").localeCompare(String(right.identity || ""));
    }
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * The row to open on. An explicit request always wins, because a shared link has
 * to land where it points even when that run drew nothing. Also inlined.
 */
export function pickDefaultRow(rows, policy, requestedIdentity = "") {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (requestedIdentity) {
    const explicit = rows.find((row) => row.identity === requestedIdentity);
    if (explicit) return explicit;
  }
  return [...rows].sort((left, right) => compareSelectionRows(left, right, policy))[0] || null;
}

/** Sort catalog sessions in place-free fashion by the same policy. */
export function sortSessionsForDefault(sessions, policy) {
  return [...sessions]
    .map((session) => sessionSelectionRow(session))
    .sort((left, right) => compareSelectionRows(left, right, policy))
    .map((row) => row.session);
}

/** Sort catalog projects by the same policy. */
export function sortProjectsForDefault(projects, policy) {
  return [...projects]
    .map((project) => projectSelectionRow(project, policy))
    .sort((left, right) => compareSelectionRows(left, right, policy))
    .map((row) => row.project);
}

/** Serialize the selection helpers for inlining into the browser bundle. */
export function serializeDefaultSelectionResolvers() {
  return [
    resolveDrawabilityClass,
    sessionSelectionRow,
    projectSelectionRow,
    compareSelectionRows,
    pickDefaultRow,
  ].map((fn) => fn.toString()).join("\n\n");
}

/** The ordering contract the shipped page hands to its client script. */
export function serializeDefaultSelectionPolicyForClient(policy) {
  return Object.freeze({
    rankOrder: policy.rankOrder,
    drawabilityRank: policy.drawabilityRank,
    provenanceRank: policy.provenanceRank,
  });
}
