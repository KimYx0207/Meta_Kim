/**
 * The default landing view has to open on a run that can be drawn.
 *
 * Measured against the running hub: opening the bare root URL selected a session
 * with zero task nodes, and the canvas showed one sentence instead of a graph.
 * Only 21 of 114 catalogued sessions had any nodes at all, and of the twelve
 * registered projects the one that sorted first carried 0 substantive sessions
 * out of 17 while another carried 29 out of 44.
 *
 * The cause was an ordering term, not missing data. Both the project sort in the
 * hub server and the session sort in the catalog compared liveness first
 * (`Number(right.active) - Number(left.active)`), so a freshly activated shell
 * that had done nothing outranked every run that produced output. The catalog
 * payload already carried `substanceClass` and, when a governed artifact
 * declared collections, `nodeCount`.
 *
 * These assertions pin the ordering to one configured policy and make the
 * measured defect unrepresentable in configuration: a rank order that puts
 * liveness or recency ahead of drawability is rejected at load, and a rank order
 * that simply omits drawability cannot be written because every key is required.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LIVE_DEFAULT_SELECTION_CONFIG_URL,
  LIVE_DEFAULT_SELECTION_SCHEMA_VERSION,
  LIVE_DRAWABILITY_CLASSES,
  LIVE_SELECTION_RANK_KEYS,
  compareSelectionRows,
  loadLiveDefaultSelectionPolicy,
  normalizeLiveDefaultSelectionPolicy,
  pickDefaultRow,
  projectSelectionRow,
  resolveDrawabilityClass,
  serializeDefaultSelectionPolicyForClient,
  sessionSelectionRow,
} from "../../src/application/live/live-default-selection.mjs";
import { LIVE_RECORD_ORIGINS } from "../../src/application/live/live-record-origin.mjs";

const POLICY = loadLiveDefaultSelectionPolicy();
const SHIPPED = JSON.parse(readFileSync(LIVE_DEFAULT_SELECTION_CONFIG_URL, "utf8"));

/** A raw document that only differs from the shipped one in the named fields. */
function shippedWith(overrides) {
  return { ...structuredClone(SHIPPED), ...overrides };
}

test("the shipped policy ranks every key and every drawability class exactly once", () => {
  assert.equal(POLICY.schemaVersion, LIVE_DEFAULT_SELECTION_SCHEMA_VERSION);
  assert.deepEqual(
    [...POLICY.rankOrder].sort(),
    [...LIVE_SELECTION_RANK_KEYS].sort(),
    "a rank order that omits a key would leave that comparison silently unused",
  );
  assert.deepEqual(
    Object.keys(POLICY.drawabilityRank).sort(),
    [...LIVE_DRAWABILITY_CLASSES].sort(),
    "a class without a weight would fall through to whatever the next term said",
  );
});

test("drawability weights stay strictly ordered by the declared class order", () => {
  const weights = LIVE_DRAWABILITY_CLASSES.map((name) => POLICY.drawabilityRank[name]);
  for (let index = 1; index < weights.length; index += 1) {
    assert.ok(
      weights[index - 1] > weights[index],
      `${LIVE_DRAWABILITY_CLASSES[index - 1]} must outrank ${LIVE_DRAWABILITY_CLASSES[index]}, `
        + "otherwise a run with nothing to draw can be chosen over one that has nodes",
    );
  }
});

test("a rank order that puts liveness or recency above drawability is rejected", () => {
  for (const key of ["active", "recency"]) {
    // Provenance stays first so this case isolates one violation: with it moved
    // down, the provenance guard would fire and the drawability guard would
    // never be reached, and the assertion would pass without exercising it.
    const rankOrder = ["provenance", key, "drawability", ...LIVE_SELECTION_RANK_KEYS.filter(
      (candidate) => candidate !== key && candidate !== "drawability"
        && candidate !== "provenance" && candidate !== "identity",
    ), "identity"];
    assert.throws(
      () => normalizeLiveDefaultSelectionPolicy(shippedWith({ rankOrder })),
      (error) => error.code === "LIVE_DEFAULT_SELECTION_DRAWABILITY_OUTRANKED",
      `${key} ahead of drawability is the measured defect and must not be configurable`,
    );
  }
});

test("an incomplete or mis-terminated rank order is rejected", () => {
  assert.throws(
    () => normalizeLiveDefaultSelectionPolicy(shippedWith({
      rankOrder: POLICY.rankOrder.filter((key) => key !== "commitment"),
    })),
    (error) => error.code === "LIVE_DEFAULT_SELECTION_RANK_ORDER_INCOMPLETE",
  );
  assert.throws(
    () => normalizeLiveDefaultSelectionPolicy(shippedWith({
      rankOrder: ["identity", ...POLICY.rankOrder.filter((key) => key !== "identity")],
    })),
    (error) => error.code === "LIVE_DEFAULT_SELECTION_IDENTITY_NOT_LAST",
    "identity is the only total tie-break, so anything after it can never run",
  );
  assert.throws(
    () => normalizeLiveDefaultSelectionPolicy(shippedWith({
      drawabilityRank: Object.fromEntries(
        Object.entries(SHIPPED.drawabilityRank).filter(([name]) => name !== "unknown"),
      ),
    })),
    (error) => error.code === "LIVE_DEFAULT_SELECTION_RANK_INCOMPLETE",
  );
});

test("drawability classification stays total and reads measured counts first", () => {
  assert.equal(resolveDrawabilityClass({ nodeCount: 8, substanceClass: "activation_only" }), "measured_nodes");
  assert.equal(resolveDrawabilityClass({ nodeCount: 0, substanceClass: "substantive" }), "measured_empty");
  assert.equal(resolveDrawabilityClass({ substanceClass: "substantive" }), "substantive");
  assert.equal(resolveDrawabilityClass({ substanceClass: "activation_only" }), "activation_only");
  for (const input of [undefined, null, {}, { substanceClass: "unknown" }, { nodeCount: "8" }, 7]) {
    assert.ok(
      LIVE_DRAWABILITY_CLASSES.includes(resolveDrawabilityClass(input)),
      `classification must stay inside the declared vocabulary for ${JSON.stringify(input)}`,
    );
  }
});

test("a live run that produced nothing loses to a finished run that produced something", () => {
  // The exact pair measured on the hub: the newest row was an activation
  // receipt flagged active, and the row with a drawable graph was older.
  const emptyAndLive = sessionSelectionRow({
    runId: "meta-2026-09-01t13-46-20-387z-3dca58c90e3b45ec",
    substanceClass: "activation_only",
    active: true,
    updatedAt: "2026-09-01T13:46:20.387Z",
  });
  const drawableAndFinished = sessionSelectionRow({
    runId: "live-ui-regression",
    substanceClass: "substantive",
    nodeCount: 8,
    active: false,
    updatedAt: "2026-08-30T02:11:00.000Z",
  });
  assert.ok(
    compareSelectionRows(drawableAndFinished, emptyAndLive, POLICY) < 0,
    "the drawable run must sort first, or the landing view opens on an empty canvas",
  );
  assert.equal(
    pickDefaultRow([emptyAndLive, drawableAndFinished], POLICY).identity,
    "live-ui-regression",
  );
});

test("liveness still decides between two runs that are equally drawable", () => {
  const older = sessionSelectionRow({
    runId: "a-run", substanceClass: "substantive", active: false, updatedAt: "2026-08-01T00:00:00.000Z",
  });
  const live = sessionSelectionRow({
    runId: "b-run", substanceClass: "substantive", active: true, updatedAt: "2026-07-01T00:00:00.000Z",
  });
  assert.equal(pickDefaultRow([older, live], POLICY).identity, "b-run");
});

test("an explicitly requested row wins even when it is the worst row", () => {
  const rows = [
    sessionSelectionRow({ runId: "drawable", substanceClass: "substantive", nodeCount: 14 }),
    sessionSelectionRow({ runId: "empty-shell", substanceClass: "activation_only" }),
  ];
  assert.equal(pickDefaultRow(rows, POLICY, "empty-shell").identity, "empty-shell");
  assert.equal(
    pickDefaultRow(rows, POLICY, "never-registered").identity,
    "drawable",
    "an unknown request must fall back to the ranked choice instead of returning nothing",
  );
  assert.equal(pickDefaultRow([], POLICY), null);
});

test("a project inherits the best drawability among its sessions", () => {
  // Measured shape: project-8552b4a70c5f was flagged active with 0 substantive
  // sessions out of 17; project-34bcf295e70a was idle with 29 of 44.
  const liveButEmpty = projectSelectionRow({
    projectId: "project-8552b4a70c5f",
    status: "active",
    updatedAt: "2026-09-01T13:46:20.387Z",
    sessions: Array.from({ length: 17 }, (_, index) => ({
      runId: "shell-" + index, substanceClass: "activation_only", active: index === 0,
    })),
  }, POLICY);
  const idleWithWork = projectSelectionRow({
    projectId: "project-34bcf295e70a",
    status: "idle",
    updatedAt: "2026-08-30T02:11:00.000Z",
    sessions: [
      { runId: "live-ui-regression", substanceClass: "substantive", nodeCount: 8 },
      { runId: "shell", substanceClass: "activation_only" },
    ],
  }, POLICY);
  assert.equal(liveButEmpty.drawabilityClass, "activation_only");
  assert.equal(idleWithWork.drawabilityClass, "measured_nodes");
  assert.equal(
    pickDefaultRow([liveButEmpty, idleWithWork], POLICY).identity,
    "project-34bcf295e70a",
    "a project with nothing to draw must not be the landing project",
  );
  assert.equal(projectSelectionRow({ projectId: "empty", sessions: [] }, POLICY).drawabilityClass, "unknown");
});

test("the client copy of the policy carries the whole ordering contract", () => {
  const forClient = serializeDefaultSelectionPolicyForClient(POLICY);
  assert.deepEqual(forClient.rankOrder, POLICY.rankOrder);
  assert.deepEqual(forClient.drawabilityRank, POLICY.drawabilityRank);
  const rowsSortedInBrowser = pickDefaultRow(
    [
      sessionSelectionRow({ runId: "shell", substanceClass: "activation_only", active: true }),
      sessionSelectionRow({ runId: "real", substanceClass: "substantive" }),
    ],
    forClient,
  );
  assert.equal(rowsSortedInBrowser.identity, "real", "the browser copy must rank the same way the server does");
});

// A fixture is drawable by construction: it always carries the node collections
// and resolved runtime a real activation often lacks. Measured on this repo, the
// only two of 44 rows with worker counts and a runtime were both acceptance
// fixtures, and drawability-first ordering put them at the top of the list and
// opened the control room on one of them. Provenance therefore has to outrank
// drawability, or the fix for the empty-canvas defect becomes the mechanism that
// presents a fixture as the project's best real run.
test("a drawable fixture loses to a real run that has nothing to draw", () => {
  const fixture = sessionSelectionRow({
    runId: "fixture-claude-code-acceptance",
    recordOrigin: "acceptance_fixture",
    substanceClass: "substantive",
    nodeCount: 8,
    active: true,
    updatedAt: "2026-09-01T13:46:20.387Z",
  });
  const realButEmpty = sessionSelectionRow({
    runId: "meta-2026-09-01t13-40-00-000z-aaaaaaaaaaaaaaaa",
    substanceClass: "activation_only",
    active: false,
    updatedAt: "2026-08-30T02:11:00.000Z",
  });
  assert.ok(
    compareSelectionRows(realButEmpty, fixture, POLICY) < 0,
    "a real run must sort ahead of a fixture even when the fixture is the only drawable row",
  );
  assert.equal(pickDefaultRow([fixture, realButEmpty], POLICY).identity, realButEmpty.identity);
});

test("provenance ranking stays total and keeps a fixture-only project selectable", () => {
  const onlyFixtures = [
    sessionSelectionRow({ runId: "fixture-a", recordOrigin: "acceptance_fixture", nodeCount: 3 }),
    sessionSelectionRow({ runId: "demo-b", recordOrigin: "demo", nodeCount: 9 }),
  ];
  assert.equal(
    pickDefaultRow(onlyFixtures, POLICY).identity,
    "fixture-a",
    "with no real run to open, a row must still be chosen so the page can label what it is showing",
  );
  assert.equal(
    pickDefaultRow(
      [
        sessionSelectionRow({ runId: "spoofed", recordOrigin: "definitely-real", substanceClass: "activation_only" }),
        sessionSelectionRow({ runId: "fixture-c", recordOrigin: "acceptance_fixture", nodeCount: 40 }),
      ],
      POLICY,
    ).identity,
    "spoofed",
    "an unrecognized origin ranks as a governed run rather than inventing a rank of its own",
  );
  assert.equal(
    pickDefaultRow(onlyFixtures, POLICY, "demo-b").identity,
    "demo-b",
    "an explicit link must still land where it points, fixture or not",
  );
});

test("provenance weights stay strictly ordered and outrank drawability in configuration", () => {
  assert.ok(
    LIVE_SELECTION_RANK_KEYS.includes("provenance"),
    "provenance must be a declared rank key, otherwise the comparison is silently never applied",
  );
  assert.deepEqual(
    Object.keys(POLICY.provenanceRank).sort(),
    [...LIVE_RECORD_ORIGINS].sort(),
    "an origin without a weight would fall through to whatever the next term said",
  );
  const weights = LIVE_RECORD_ORIGINS.map((name) => POLICY.provenanceRank[name]);
  for (let index = 1; index < weights.length; index += 1) {
    assert.ok(
      weights[index - 1] > weights[index],
      `${LIVE_RECORD_ORIGINS[index - 1]} must outrank ${LIVE_RECORD_ORIGINS[index]}`,
    );
  }
  assert.equal(POLICY.rankOrder[0], "provenance");
  for (const key of ["drawability", "active", "recency"]) {
    const rankOrder = [key, ...POLICY.rankOrder.filter((candidate) => candidate !== key)];
    assert.throws(
      () => normalizeLiveDefaultSelectionPolicy(shippedWith({ rankOrder })),
      (error) => error.code === "LIVE_DEFAULT_SELECTION_PROVENANCE_OUTRANKED",
      `${key} ahead of provenance re-opens the measured defect and must not be configurable`,
    );
  }
  assert.throws(
    () => normalizeLiveDefaultSelectionPolicy(shippedWith({
      provenanceRank: Object.fromEntries(
        Object.entries(SHIPPED.provenanceRank).filter(([name]) => name !== "demo"),
      ),
    })),
    (error) => error.code === "LIVE_DEFAULT_SELECTION_RANK_INCOMPLETE",
  );
});

test("both read paths route their default choice through this policy", () => {
  const sources = {
    "src/infrastructure/live/live-control-room-server.mjs": readFileSync(
      new URL("../../src/infrastructure/live/live-control-room-server.mjs", import.meta.url),
      "utf8",
    ),
    "src/infrastructure/live/live-hub-project-catalog.mjs": readFileSync(
      new URL("../../src/infrastructure/live/live-hub-project-catalog.mjs", import.meta.url),
      "utf8",
    ),
    "src/presentation/live/live-control-room-page.mjs": readFileSync(
      new URL("../../src/presentation/live/live-control-room-page.mjs", import.meta.url),
      "utf8",
    ),
  };
  for (const [path, source] of Object.entries(sources)) {
    assert.match(
      source,
      /live-default-selection\.mjs/u,
      `${path} chooses a default row, so it must read the shared selection policy`,
    );
    // Written against the two shapes actually found in this repo: the catalog's
    // `Number(right.active)` and the page's `Number(right.status === "active"
    // || right.sessions.some(...))`. The earlier pattern required `active` to
    // follow `right.` with no space, so the page's inline comparator - the same
    // defect, one property deeper - slipped past a guard that read as covering it.
    assert.doesNotMatch(
      source,
      /Number\((?=[^)]*\bactive\b)[^;]*?\)\s*\n?\s*-\s*Number\(/u,
      `${path} still compares liveness with its own inline term, which is the measured defect`,
    );
  }
});
