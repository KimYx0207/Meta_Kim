import path from "node:path";
import { buildProjectRef, listJoinedProjectRegistryEntries, listLiveNativeCodexBindings, listLiveNativeZcodeBindings } from "../../../scripts/project-registry.mjs";
import { createCodexNativeSessionReader } from "./codex-native-session-reader.mjs";
import { buildNativeCodexLiveSnapshot, nativeCodexSessionCatalogRow } from "../../application/live/live-native-codex-projection.mjs";
import { createZcodeNativeSessionReader, discoverZcodeNativeBinding } from "./zcode-native-session-reader.mjs";
import { createClaudeNativeSessionReader, discoverClaudeNativeBinding } from "./claude-native-session-reader.mjs";
import { createLiveReadRepository } from "./live-read-repository.mjs";
import { buildNativeZcodeLiveSnapshot, buildNativeClaudeLiveSnapshot, nativeZcodeSessionCatalogRow } from "../../application/live/live-native-zcode-projection.mjs";

/** Local registry candidates still have to pass every native source binding check. */
export function createLiveNativeBindings(options = {}) {
  const readers = new Map();
  const snapshots = new Map();
  const registryEnabled = options.globalHub === true && (!options.hubCatalog || options.homeDir);
  // A registry-backed daemon may not turn a launch hint into lasting authority:
  // removing enrollment must revoke even the binding supplied at startup.
  const startup = !registryEnabled && options.nativeCodex && typeof options.nativeCodex === "object" ? options.nativeCodex : null;
  const suppliedZcode = options.nativeZcode;
  const startupZcode = !registryEnabled && suppliedZcode && typeof suppliedZcode === "object"
    && (!suppliedZcode.runId || suppliedZcode.runId === `native-zcode-${suppliedZcode.sessionId}-${suppliedZcode.turnId}`)
    ? { ...suppliedZcode, runId: undefined, runtime: "zcode" } : null;
  const keyFor = (binding) => JSON.stringify([binding.runtime || "codex", binding.projectRoot, binding.threadId || binding.sessionId, binding.turnId || "", binding.codexHome || binding.zcodeHome || binding.claudeHome || "", binding.runId || ""]);
  function readerFor(binding) {
    const key = keyFor(binding);
    if (!readers.has(key)) {
      readers.set(key, { reader: binding.runtime === "claude" ? createClaudeNativeSessionReader(binding) : binding.runtime === "zcode" ? createZcodeNativeSessionReader(binding) : createCodexNativeSessionReader(binding), binding });
      if (readers.size > 64) readers.delete(readers.keys().next().value);
    }
    return readers.get(key);
  }
  if (startup) readerFor(startup);
  if (startupZcode) readerFor(startupZcode);
  const profile = options.hubCatalog?.profile || options.profile || process.env.META_KIM_PROFILE || "default";
  let catalogBindings = [];
  let catalogExpires = 0;
  let catalogKeys = new Set();
  const discoveryCache = new Map();
  const exactRun = /^native-codex-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/iu;
  const zcodeRunFor = (binding) => binding.runId || `native-zcode-${binding.sessionId}-${binding.turnId}`;
  async function read({ projectRoot = null, projectRef = null, runId = null, catalog = false } = {}) {
    const match = runId ? exactRun.exec(runId) : null;
    if (runId?.startsWith("native-codex-") && !match) return null;
    const selectedRef = projectRef || (projectRoot ? buildProjectRef({ repoPath: projectRoot }) : null);
    const targeted = Boolean(selectedRef || runId);
    let bindings = [];
    if (registryEnabled) {
      if (targeted) {
        const [codex, zcode] = await Promise.all([
          !runId || match ? listLiveNativeCodexBindings({ homeDir: options.homeDir, profile, projectRef: selectedRef, threadId: match?.[1], turnId: match?.[2] }) : [],
          !match ? listLiveNativeZcodeBindings({ homeDir: options.homeDir, profile, projectRef: selectedRef, runId }) : [],
        ]);
        bindings = [...codex, ...zcode];
        const matchesTarget = (binding) => (!selectedRef || buildProjectRef({ repoPath: binding.projectRoot }) === selectedRef)
          && (!runId || (["zcode", "claude"].includes(binding.runtime) ? binding.runId === runId || zcodeRunFor(binding) === runId : Boolean(match) && binding.threadId?.toLowerCase() === match[1].toLowerCase()))
          && (!match || !binding.turnId || binding.turnId.toLowerCase() === match[2].toLowerCase());
        catalogBindings = [...bindings, ...catalogBindings.filter((binding) => !matchesTarget(binding))].slice(0, 32);
      }
      else {
        if (Date.now() >= catalogExpires) {
          const [codex, zcode] = await Promise.all([
            listLiveNativeCodexBindings({ homeDir: options.homeDir, profile }),
            listLiveNativeZcodeBindings({ homeDir: options.homeDir, profile }),
          ]);
          catalogBindings = [...codex, ...zcode];
          catalogExpires = Date.now() + 1_000;
        }
        bindings = catalogBindings;
      }
    }
    if (startup) bindings = [...bindings, startup];
    if (startupZcode) bindings = [...bindings, startupZcode];
    // A lifecycle receipt can identify its native input by the existing project
    // HMAC. This is a read-only join, not another saved run/status authority.
    if (projectRoot && runId?.startsWith("meta-") && !bindings.some((binding) => ["zcode", "claude"].includes(binding.runtime) && binding.runId === runId)) {
      const enrolled = !registryEnabled || (await listJoinedProjectRegistryEntries({ homeDir: options.homeDir }))
        .some((project) => project.projectRef === selectedRef && path.relative(projectRoot, project.repoRoot) === "");
      if (enrolled) {
        const repository = createLiveReadRepository({ projectRoot, profile });
        const active = await repository.readDurableStatus();
        const durableStatus = active?.runId === runId ? active : await repository.readRunStatus(runId);
        if (durableStatus?.runId === runId && durableStatus.taskFingerprint) {
          const sourceRuntime = durableStatus.sourceConversation?.runtime || durableStatus.sourceRuntime;
          const cacheKey = JSON.stringify([projectRoot, runId, durableStatus.taskFingerprint, sourceRuntime, durableStatus.sourceConversation?.conversationId || durableStatus.stageRuntimeControl?.nativeSessionHint?.sessionId || ""]);
          let cached = discoveryCache.get(cacheKey);
          if (!cached || cached.expires < Date.now()) {
            const unknown = !sourceRuntime || ["unavailable", "unknown", "shared"].includes(sourceRuntime);
            const [claude, zcode] = await Promise.all([
              sourceRuntime === "claude" || unknown ? discoverClaudeNativeBinding({ projectRoot, runId, profile, durableStatus, claudeHome: options.claudeHome || process.env.CLAUDE_CONFIG_DIR }).catch(() => null) : null,
              sourceRuntime === "zcode" || unknown ? discoverZcodeNativeBinding({ projectRoot, runId, profile, durableStatus, zcodeHome: options.zcodeHome || process.env.ZCODE_HOME }).then((binding) => binding ? { ...binding, runtime: "zcode" } : null).catch(() => null) : null,
            ]);
            const candidates = [claude, zcode].filter(Boolean);
            const binding = candidates.length === 1 ? candidates[0] : null;
            cached = { binding, expires: binding ? Infinity : Date.now() + 1_000 };
            discoveryCache.set(cacheKey, cached);
            if (discoveryCache.size > 32) discoveryCache.delete(discoveryCache.keys().next().value);
          }
          if (cached.binding) bindings.push(cached.binding);
        }
      }
    }
    if (catalog && !targeted) catalogKeys = new Set();
    // Every selected/SSE read rechecks local enrollment; cached readers confer no authority.
    const eligible = bindings.filter((binding) => (!selectedRef || buildProjectRef({ repoPath: binding.projectRoot }) === selectedRef)
      && (!projectRoot || path.relative(projectRoot, binding.projectRoot) === "")
      && (!runId || (["zcode", "claude"].includes(binding.runtime) ? binding.runId === runId || zcodeRunFor(binding) === runId : Boolean(match) && binding.threadId.toLowerCase() === match[1].toLowerCase()))
      && (!match || !binding.turnId || binding.turnId.toLowerCase() === match[2].toLowerCase()));
    let selected = null;
    for (const binding of eligible) {
      const { reader } = readerFor(binding);
      const readerKey = keyFor(binding);
      const observation = await (match ? reader.readTurn(match[2]) : reader.read()).catch(() => null);
      const snapshot = observation && (binding.runtime === "claude" ? buildNativeClaudeLiveSnapshot(observation) : binding.runtime === "zcode" ? buildNativeZcodeLiveSnapshot(observation) : buildNativeCodexLiveSnapshot(observation));
      if (!snapshot) continue;
      const ref = buildProjectRef({ repoPath: reader.projectRoot });
      const snapshotKey = ref + ":" + snapshot.run.runId;
      snapshots.set(snapshotKey, { projectRef: ref, projectRoot: reader.projectRoot, readerKey, snapshot });
      if (catalog || binding.runtime === "claude") catalogKeys.add(snapshotKey);
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
  async function mergeProjects(rows) {
    // A cold catalog resolves the current Claude run from the same durable
    // project record used by an explicit snapshot request.
    const claudeProjects = rows.filter((project) => project.sessions?.some((session) => session.sourceRuntime === "claude"));
    if (registryEnabled && claudeProjects.length) {
      const enrolled = await listJoinedProjectRegistryEntries({ homeDir: options.homeDir });
      for (const project of claudeProjects) {
        const root = enrolled.find((entry) => entry.projectRef === project.projectRef)?.repoRoot;
        if (!root) continue;
        const durable = await createLiveReadRepository({ projectRoot: root, profile }).readDurableStatus();
        if (durable?.runId) await read({ projectRoot: root, projectRef: project.projectRef, runId: durable.runId, catalog: true });
      }
    }
    const result = [...rows];
    const groups = new Map();
    for (const [key, entry] of snapshots) {
      if (!catalogKeys.has(key)) continue;
      if (!groups.has(entry.projectRef)) groups.set(entry.projectRef, []);
      groups.get(entry.projectRef).push(entry);
    }
    for (const [projectRef, entries] of groups) {
      entries.sort((a, b) => String(b.snapshot.run.startedAt).localeCompare(String(a.snapshot.run.startedAt)));
      const sessions = entries.map(({ snapshot }) => ["zcode", "claude"].includes(snapshot.run.sourceRuntime)
        ? nativeZcodeSessionCatalogRow(snapshot) : nativeCodexSessionCatalogRow(snapshot));
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
    async isNativeRun(projectRoot, runId) {
      if (typeof runId !== "string") return false;
      if (runId.startsWith("native-codex-") || runId.startsWith("native-zcode-")) return true;
      const projectRef = buildProjectRef({ repoPath: projectRoot });
      if (runId.startsWith("meta-")) {
        const observed = await read({ projectRoot, projectRef, runId, catalog: true });
        if (["zcode", "claude"].includes(observed?.run.sourceRuntime)) return true;
      }
      if (registryEnabled) return (await listLiveNativeZcodeBindings({ homeDir: options.homeDir, profile, projectRef, runId })).length > 0;
      return Boolean(startupZcode && path.relative(projectRoot, startupZcode.projectRoot) === "" && zcodeRunFor(startupZcode) === runId);
    },
    hasProject: (projectRoot) => [...readers.values()].some(({ reader }) => path.relative(projectRoot, reader.projectRoot) === ""),
    snapshotFor: (projectRef, runId) => snapshots.get(`${projectRef}:${runId}`)?.snapshot || null,
    projectFor: (projectRef) => [...snapshots.values()].find((entry) => entry.projectRef === projectRef) || null,
  };
}
