import path from "node:path";
import { buildProjectRef, listLiveNativeCodexBindings } from "../../../scripts/project-registry.mjs";
import { createCodexNativeSessionReader } from "./codex-native-session-reader.mjs";
import { buildNativeCodexLiveSnapshot, nativeCodexSessionCatalogRow } from "../../application/live/live-native-codex-projection.mjs";

/** Local registry candidates still have to pass every native source binding check. */
export function createLiveNativeBindings(options = {}) {
  const readers = new Map();
  const snapshots = new Map();
  const registryEnabled = options.globalHub === true && (!options.hubCatalog || options.homeDir);
  // A registry-backed daemon may not turn a launch hint into lasting authority:
  // removing enrollment must revoke even the binding supplied at startup.
  const startup = !registryEnabled && options.nativeCodex && typeof options.nativeCodex === "object" ? options.nativeCodex : null;
  const keyFor = (binding) => JSON.stringify([binding.projectRoot, binding.threadId, binding.turnId || "", binding.codexHome || ""]);
  function readerFor(binding) {
    const key = keyFor(binding);
    if (!readers.has(key)) {
      readers.set(key, { reader: createCodexNativeSessionReader(binding), binding });
      if (readers.size > 64) readers.delete(readers.keys().next().value);
    }
    return readers.get(key);
  }
  if (startup) readerFor(startup);
  const profile = options.hubCatalog?.profile || options.profile || process.env.META_KIM_PROFILE || "default";
  let catalogBindings = [];
  let catalogExpires = 0;
  let catalogKeys = new Set();
  const exactRun = /^native-codex-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/iu;
  async function read({ projectRoot = null, projectRef = null, runId = null, catalog = false } = {}) {
    const match = runId ? exactRun.exec(runId) : null;
    if (runId && !match) return null;
    const selectedRef = projectRef || (projectRoot ? buildProjectRef({ repoPath: projectRoot }) : null);
    const targeted = Boolean(selectedRef || runId);
    let bindings = [];
    if (registryEnabled) {
      if (targeted) {
        bindings = await listLiveNativeCodexBindings({ homeDir: options.homeDir, profile, projectRef: selectedRef, threadId: match?.[1], turnId: match?.[2] });
        const matchesTarget = (binding) => (!selectedRef || buildProjectRef({ repoPath: binding.projectRoot }) === selectedRef)
          && (!match || binding.threadId.toLowerCase() === match[1].toLowerCase())
          && (!match || !binding.turnId || binding.turnId.toLowerCase() === match[2].toLowerCase());
        catalogBindings = [...bindings, ...catalogBindings.filter((binding) => !matchesTarget(binding))].slice(0, 32);
      }
      else {
        if (Date.now() >= catalogExpires) {
          catalogBindings = await listLiveNativeCodexBindings({ homeDir: options.homeDir, profile });
          catalogExpires = Date.now() + 1_000;
        }
        bindings = catalogBindings;
      }
    }
    if (startup) bindings = [...bindings, startup];
    if (catalog && !targeted) catalogKeys = new Set();
    // Every selected/SSE read rechecks local enrollment; cached readers confer no authority.
    const eligible = bindings.filter((binding) => (!selectedRef || buildProjectRef({ repoPath: binding.projectRoot }) === selectedRef)
      && (!projectRoot || path.relative(projectRoot, binding.projectRoot) === "")
      && (!match || binding.threadId.toLowerCase() === match[1].toLowerCase())
      && (!match || !binding.turnId || binding.turnId.toLowerCase() === match[2].toLowerCase()));
    let selected = null;
    for (const binding of eligible) {
      const { reader } = readerFor(binding);
      const readerKey = keyFor(binding);
      const observation = await (match ? reader.readTurn(match[2]) : reader.read()).catch(() => null);
      const snapshot = observation && buildNativeCodexLiveSnapshot(observation);
      if (!snapshot) continue;
      const ref = buildProjectRef({ repoPath: reader.projectRoot });
      const snapshotKey = ref + ":" + snapshot.run.runId;
      snapshots.set(snapshotKey, { projectRef: ref, projectRoot: reader.projectRoot, readerKey, snapshot });
      if (catalog) catalogKeys.add(snapshotKey);
      if (!selected) selected = snapshot;
      if (snapshots.size > 64) snapshots.delete(snapshots.keys().next().value);
    }
    // A targeted project/thread that has lost enrollment must not survive in the catalog.
    if (targeted && !selected) for (const [key, entry] of snapshots) {
      if ((!selectedRef || entry.projectRef === selectedRef) && (!runId || entry.snapshot.run.runId === runId)) {
        snapshots.delete(key); catalogKeys.delete(key);
      }
    }
    return selected;
  }
  function mergeProjects(rows) {
    const result = [...rows];
    const groups = new Map();
    for (const [key, entry] of snapshots) {
      if (!catalogKeys.has(key)) continue;
      if (!groups.has(entry.projectRef)) groups.set(entry.projectRef, []);
      groups.get(entry.projectRef).push(entry);
    }
    for (const [projectRef, entries] of groups) {
      entries.sort((a, b) => String(b.snapshot.run.startedAt).localeCompare(String(a.snapshot.run.startedAt)));
      const sessions = entries.map(({ snapshot }) => nativeCodexSessionCatalogRow(snapshot));
      const existingIndex = result.findIndex((project) => project.projectRef === projectRef);
      const existing = result[existingIndex] || {};
      const nativeIds = new Set(sessions.map((session) => session.runId));
      const project = { ...existing, projectRef, repoRoot: entries[0].projectRoot,
        displayName: existing.displayName || path.basename(entries[0].projectRoot),
        status: sessions[0].status, activeSessionId: sessions.find((session) => session.active)?.sessionId || existing.activeSessionId || null,
        updatedAt: sessions[0].updatedAt, sessions: [...sessions, ...(existing.sessions || []).filter((session) => !nativeIds.has(session.runId))] };
      project.sessionCount = project.sessions.length;
      if (existingIndex >= 0) result[existingIndex] = project;
      else result.push(project);
    }
    return result;
  }
  return {
    read, mergeProjects,
    hasProject: (projectRoot) => [...readers.values()].some(({ reader }) => path.relative(projectRoot, reader.projectRoot) === ""),
    snapshotFor: (projectRef, runId) => snapshots.get(`${projectRef}:${runId}`)?.snapshot || null,
    projectFor: (projectRef) => [...snapshots.values()].find((entry) => entry.projectRef === projectRef) || null,
  };
}
