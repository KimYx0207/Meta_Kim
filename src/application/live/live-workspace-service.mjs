import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createLiveWorkspaceRepository } from "../../data/repositories/live-workspace-repository.mjs";
import { normalizeSoftwareDesign } from "../../domain/design/software-design.mjs";
import { buildLocalReviewClaim, claimHostAnswer, invalidateDecision } from "../../domain/decision/decision.mjs";
import { STAGE_ORDER, STAGE_PUBLIC_LABELS } from "../../../canonical/runtime-assets/shared/hooks/spine-state-gates.mjs";
import { taskProgressGoal } from "../../../canonical/runtime-assets/shared/hooks/task-progress.mjs";
import { loadLiveWorkspacePolicy } from "./live-workspace-policy.mjs";
import { liveRecordOrigin } from "./live-record-origin.mjs";
import { LIVE_WORKSPACE_SCHEMA, LIVE_WORKSPACE_STATE_SCHEMA, workspaceDigest, workspaceBytesDigest,
  workspaceRequire, workspaceFailure, workspaceText, workspaceVersion, createWorkspaceReview,
  workspaceReviewState, deriveWorkspaceProgress, boundedWorkspaceRequest } from "../../domain/live/live-workspace.mjs";

const object = value => value && typeof value === "object" && !Array.isArray(value);
const identifier = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/u.test(value);
const nativeBoundary = { nativeInvocationVerified: false, completionVerified: false, publicReadyAuthority: false };

/** Local private design workspace. The existing spine is its transaction
 * authority; text files are immutable materials, never a second run database. */
export function createLiveWorkspaceService(options) {
  const policy = options.policy || loadLiveWorkspacePolicy();
  const repository = options.repository || createLiveWorkspaceRepository({ ...options, policy });
  const now = options.now || (() => new Date().toISOString());
  const projectId = options.projectId || null;
  const publicRequest = request => boundedWorkspaceRequest(request.status === "host_claimed" &&
    Date.parse(request.claim?.expiresAt) <= Date.parse(now()) ? { ...request, status: "in_doubt" } : request);
  function requestPage(state, workspace, cursor = null) {
    const revision = state.hostCheckpointRevision || 0;
    let offset = 0;
    if (cursor) {
      workspaceRequire(typeof cursor === "string" && cursor.length <= 1024, "workspace_cursor_invalid");
      let decoded;
      try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw workspaceFailure("workspace_cursor_invalid"); }
      workspaceRequire(decoded.runId === state.runId && decoded.projectBinding === workspace.projectBinding && decoded.revision === revision &&
        Number.isSafeInteger(decoded.offset) && decoded.offset >= 0 && decoded.offset <= workspace.requests.length, "workspace_cursor_version_conflict", 409);
      offset = decoded.offset;
    }
    const rows = workspace.requests.toReversed().slice(offset, offset + policy.requestPageSize);
    const nextOffset = offset + rows.length;
    return { revision, requests: rows.map(publicRequest), total: workspace.requests.length, order: "newest_first",
      nextCursor: nextOffset < workspace.requests.length ? Buffer.from(JSON.stringify({ runId: state.runId,
        projectBinding: workspace.projectBinding, revision, offset: nextOffset })).toString("base64url") : null };
  }

  async function stateFor(runId, { mutate = false, expectedRevision } = {}) {
    workspaceRequire(identifier(runId), "workspace_run_invalid");
    let state = await repository.readState();
    if (!mutate && state?.runId !== runId && repository.readHistoricalState) state = await repository.readHistoricalState(runId);
    workspaceRequire(state?.runId === runId, "workspace_current_run_unavailable", 404);
    if (mutate) {
      workspaceRequire(state.active === true, "workspace_run_inactive", 409);
      workspaceRequire(state.conversationLinkState === "verified" && state.sourceConversation?.runId === runId &&
        state.sourceConversation.matchBasis === "transcript_file_verified", "workspace_host_binding_unavailable", 409);
      if (expectedRevision !== undefined) workspaceRequire(Number.isSafeInteger(expectedRevision) &&
        expectedRevision === (state.hostCheckpointRevision || 0), "workspace_revision_conflict", 409);
    }
    return state;
  }
  function workspaceFor(state) {
    const workspace = state.liveWorkspace;
    workspaceRequire(workspace?.schemaVersion === LIVE_WORKSPACE_STATE_SCHEMA && workspace.runId === state.runId &&
      Array.isArray(workspace.modules) && Array.isArray(workspace.reviews) && Array.isArray(workspace.requests), "workspace_not_registered", 409);
    workspaceRequire(workspace.profile === repository.profile &&
      workspace.projectBinding === workspaceDigest([repository.projectRoot, repository.profile]), "workspace_project_binding_conflict", 409);
    // The spine JSON boundary intentionally returns null-prototype records;
    // Decision's public domain contract deliberately accepts plain records.
    return JSON.parse(JSON.stringify(workspace));
  }
  function legacyRows(runId, legacy) {
    const software = legacy.design.softwareDesign;
    workspaceRequire(software.modules.length <= policy.maxModules, "workspace_modules_invalid", 413);
    const make = (targetId, value) => {
      const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
      workspaceRequire(bytes.length <= policy.maxMaterialBytes, "workspace_material_too_large", 413);
      const sha256 = workspaceBytesDigest(bytes);
      return { artifactId: `material:${workspaceDigest([repository.projectRoot, repository.profile, runId, "legacy", targetId]).slice(0, 32)}`,
        version: workspaceVersion(sha256), sha256, format: "json", bytes };
    };
    const architecture = { id: workspaceText(software.architecture.id, 160), title: workspaceText(software.architecture.title || software.architecture.id, 160),
      summary: workspaceText(software.architecture.summary, 1000), status: "unregistered", ...make("architecture", software.architecture) };
    const modules = software.modules.map(module => ({ id: workspaceText(module.id, 160), title: workspaceText(module.title || module.id, 160),
      purpose: workspaceText(module.purpose, 1000), status: "unregistered", decisionId: null,
      dependsOn: Array.isArray(module.dependsOn) ? module.dependsOn.filter(identifier) : [], taskIds: Array.isArray(module.taskIds) ? module.taskIds.filter(identifier) : [],
      ...make(`module:${module.id}`, module) }));
    return { architecture, modules, version: workspaceVersion(legacy.sha256) };
  }
  function legacyOverview(base, legacy, cursor) {
    const rows = legacyRows(base.runId, legacy);
    let offset = 0;
    if (cursor) {
      let decoded;
      try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw workspaceFailure("workspace_cursor_invalid"); }
      workspaceRequire(decoded.version === rows.version && Number.isSafeInteger(decoded.offset) && decoded.offset >= 0 &&
        decoded.offset <= rows.modules.length, "workspace_cursor_version_conflict", 409);
      offset = decoded.offset;
    }
    const withoutBytes = ({ bytes: _bytes, ...descriptor }) => descriptor;
    const modules = rows.modules.slice(offset, offset + policy.modulePageSize).map(withoutBytes);
    const nextOffset = offset + modules.length;
    const output = { ...base, available: true, design: { status: "unregistered", version: rows.version,
      architecture: withoutBytes(rows.architecture), modules, totalModules: rows.modules.length,
      nextCursor: nextOffset < rows.modules.length ? Buffer.from(JSON.stringify({ version: rows.version, offset: nextOffset })).toString("base64url") : null },
      nextAction: { kind: "register_design_review", stage: "thinking", summary: "已有结构化设计可只读查看；由当前宿主登记后接入本地人工审阅" },
      source: { kind: "governed_design_artifact", version: rows.version, truth: "declared_design_not_local_reviewed", recordOrigin: liveRecordOrigin(legacy) } };
    workspaceRequire(Buffer.byteLength(JSON.stringify(output)) <= policy.maxOverviewBytes, "workspace_overview_limit", 413);
    return output;
  }
  function assertHost(state, conversationId, expectedRevision) {
    workspaceRequire(typeof conversationId === "string" && conversationId === state.sourceConversation?.conversationId &&
      Number.isSafeInteger(expectedRevision) && expectedRevision === (state.hostCheckpointRevision || 0), "workspace_host_scope_or_revision_conflict", 409);
  }
  function currentMaterial(workspace, artifactId, version) {
    workspaceRequire(typeof artifactId === "string" && Object.hasOwn(workspace.materials, artifactId), "workspace_material_unknown", 404);
    const material = workspace.materials[artifactId];
    workspaceRequire(version === workspaceVersion(material.sha256), "workspace_material_version_conflict", 409);
    return material;
  }
  async function verifyDependencyMaterials(workspace, target) {
    const seen = new Set();
    const visit = async id => {
      if (seen.has(id)) return; seen.add(id);
      const module = workspace.modules.find(item => item.id === id);
      workspaceRequire(module, "workspace_module_dependency_invalid", 409);
      await repository.verifyMaterial(workspace.materials[module.artifactId]);
      for (const dependency of module.dependsOn) await visit(dependency);
    };
    for (const dependency of target.dependsOn || []) await visit(dependency);
  }
  function checkNonce(input) {
    workspaceRequire(typeof input.nonce === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(input.nonce), "workspace_nonce_invalid");
  }
  function priorRequest(workspace, input, digest) {
    const prior = workspace.requests.find(request => request.nonce === input.nonce);
    if (!prior) return null;
    workspaceRequire(prior.inputDigest === digest, "workspace_nonce_conflict", 409);
    return prior;
  }
  function newRequest(workspace, { nonce, kind, targetId, inputDigest, summary, material, at, status = "waiting_host", ...extra }) {
    workspaceRequire(workspace.requests.length < policy.maxRequests, "workspace_request_capacity_reached", 413);
    const request = { commandId: `command:${workspaceDigest([repository.projectRoot, workspace.runId, nonce]).slice(0, 32)}`,
      nonce, kind, targetId, inputDigest, summary: workspaceText(summary), status, createdAt: at, updatedAt: at,
      ...(material ? { artifactId: material.artifactId, version: workspaceVersion(material.sha256) } : {}), ...extra };
    request.outlineBasis = workspace.architecture?.basisDigest || null;
    workspace.requests.push(request);
    return request;
  }
  function refreshProgress(workspace, at, { enqueue = true } = {}) {
    const progress = deriveWorkspaceProgress(workspace, Date.parse(at));
    workspace.designStatus = progress.designStatus;
    workspace.nextAction = progress.nextAction;
    workspace.updatedAt = at;
    const action = progress.nextAction;
    if (enqueue && ["design_module", "revise_module", "revise_outline", "continue_governed_run"].includes(action.kind)) {
      const target = action.moduleId ? workspace.modules.find(module => module.id === action.moduleId) : workspace.architecture;
      const material = workspace.materials[target.artifactId];
      const basis = workspaceDigest([workspace.architecture.basisDigest, action.kind, action.moduleId, material.sha256,
        target.decisionId, workspace.reviews.find(review => review.decisionId === target.decisionId)?.decision.revision]);
      const nonce = `next-${basis}`;
      const request = workspace.requests.find(item => item.nonce === nonce) || newRequest(workspace, {
        nonce, kind: action.kind, targetId: action.moduleId || "architecture", inputDigest: basis,
        summary: action.summary, material, at, generatedFromDesign: true, basisReviewId: target.decisionId,
      });
      workspace.nextAction = { ...action, commandId: request.commandId };
    }
    return progress;
  }
  const resultFor = (request, workspace, replay = false) => ({ status: publicRequest(request).status,
    commandId: request.commandId, nonce: request.nonce, replay, completionVerified: false, nextAction: workspace.nextAction });

  async function persistRequest(state, next, request, input, digest) {
    try { await repository.writeState(state, next); }
    catch (error) {
      if (error.code !== "workspace_revision_conflict") throw error;
      const current = workspaceFor(await stateFor(state.runId));
      const committed = priorRequest(current, input, digest);
      if (!committed) throw error;
      return resultFor(committed, current, true);
    }
    return resultFor(request, next.liveWorkspace);
  }

  async function publishDesign({ runId, conversationId, expectedRevision, input }) {
    const state = await stateFor(runId, { mutate: true, expectedRevision });
    assertHost(state, conversationId, expectedRevision);
    workspaceRequire(state.currentStage === "thinking", "workspace_publish_requires_thinking", 409);
    workspaceRequire(object(input) && input.schemaVersion === 1 && object(input.design) &&
      Buffer.byteLength(JSON.stringify(input)) <= policy.maxDesignBytes, "workspace_design_input_invalid");
    const design = { mode: "exploration", userJourneys: [], interfaces: [], sharedState: [], taskSlices: [], ...input.design };
    workspaceRequire(["exploration", "delivery"].includes(design.mode), "workspace_design_mode_invalid");
    const criteria = state.criticalRecord ? new Set(taskProgressGoal(state.criticalRecord).criteria.map(item => item.criterionId)) : new Set();
    const software = normalizeSoftwareDesign({ input: design.softwareDesign, design,
      settledDecisionIds: new Set(design.settledDecisionRefs || []), criterionIds: criteria });
    workspaceRequire(software && software.modules.length > 0 && software.modules.length <= policy.maxModules, "workspace_modules_invalid");
    workspaceRequire(software.modules.every(module => identifier(module.id)), "workspace_module_identity_invalid");
    const moduleIds = new Set(software.modules.map(module => module.id));
    for (const module of software.modules) workspaceRequire(Array.isArray(module.dependsOn || []) &&
      (module.dependsOn || []).every(id => moduleIds.has(id) && id !== module.id), "workspace_module_dependency_invalid");
    const order = new Map(software.architecture.moduleIds.map((id, index) => [id, index]));
    for (const module of software.modules) workspaceRequire((module.dependsOn || []).every(id => order.get(id) < order.get(module.id)),
      "workspace_module_order_must_follow_dependencies");
    const previous = state.liveWorkspace ? workspaceFor(state) : null;
    const at = now();
    const workspace = { schemaVersion: LIVE_WORKSPACE_STATE_SCHEMA, runId, profile: repository.profile, generation: (previous?.generation || 0) + 1,
      projectBinding: workspaceDigest([repository.projectRoot, repository.profile]),
      hostEntry: fileURLToPath(new URL("../../../scripts/live-workspace-host.mjs", import.meta.url)),
      createdAt: previous?.createdAt || at, updatedAt: at, materials: {}, modules: [],
      reviews: structuredClone(previous?.reviews || []), requests: structuredClone(previous?.requests || []) };
    const materialRefs = input.materialRefs || {};
    workspaceRequire(object(materialRefs) && (!materialRefs.modules || object(materialRefs.modules)), "workspace_material_refs_invalid");
    const sourceFormat = ref => /\.md$/iu.test(ref) ? "markdown" : /\.json$/iu.test(ref) ? "json" : "text";
    const material = async (targetId, value, sourceRef) => {
      const stored = sourceRef ? await repository.putSource(runId, sourceRef, sourceFormat(sourceRef))
        : await repository.putBytes(runId, Buffer.from(JSON.stringify(value, null, 2) + "\n"), "json");
      const item = { ...stored, artifactId: `material:${workspaceDigest([workspace.projectBinding, runId, targetId]).slice(0, 32)}` };
      workspace.materials[item.artifactId] = item;
      return item;
    };
    const outline = { architecture: software.architecture, modules: software.architecture.moduleIds.map(id => {
      const module = software.modules.find(item => item.id === id);
      return { id, purpose: module.purpose, dependsOn: module.dependsOn || [] };
    }) };
    const outlineMaterial = await material("architecture", outline, materialRefs.outline);
    const outlineBasis = workspaceDigest(outline);
    const reviewFor = (targetId, moduleId, currentMaterial, basisDigest, oldId) => {
      const old = workspace.reviews.find(review => review.decisionId === oldId);
      const oldState = old ? workspaceReviewState(old, Date.parse(at)) : null;
      if (old && old.sha256 === currentMaterial.sha256 && old.basisDigest === basisDigest &&
          !["expired", "invalidated"].includes(oldState)) return old;
      if (old && old.decision.status !== "invalidated") old.decision = invalidateDecision(old.decision,
        { at, reasonRef: "reason:design-material-replaced", evidence: [...old.decision.evidence,
          { evidenceRef: "context:live-replacement", digest: workspaceVersion(workspaceDigest({ materialSha256: currentMaterial.sha256, basisDigest, generation: workspace.generation })) }] });
      workspaceRequire(workspace.reviews.length < policy.maxReviews, "workspace_review_capacity_reached", 413);
      const review = createWorkspaceReview({ runId: `${workspace.projectBinding}:${runId}`, targetId, moduleId, material: currentMaterial, basisDigest,
        generation: workspace.generation, at, policy });
      workspace.reviews.push(review);
      return review;
    };
    const outlineReview = reviewFor("architecture", null, outlineMaterial, outlineBasis, previous?.architecture?.decisionId);
    workspace.architecture = { id: software.architecture.id, title: workspaceText(software.architecture.title || software.architecture.id, 160),
      summary: workspaceText(software.architecture.summary, 1000), artifactId: outlineMaterial.artifactId,
      decisionId: outlineReview.decisionId, basisDigest: outlineBasis };
    for (const id of software.architecture.moduleIds) {
      const module = software.modules.find(item => item.id === id);
      const moduleSource = materialRefs.modules && Object.hasOwn(materialRefs.modules, id) ? materialRefs.modules[id] : null;
      const moduleMaterial = await material(`module:${id}`, module, moduleSource);
      const detailed = typeof module.implementationNotes === "string" && module.implementationNotes.trim().length > 0 &&
        Array.isArray(module.businessRules) && module.businessRules.length > 0 && Array.isArray(module.states) && module.states.length > 0;
      const prior = previous?.modules?.find(item => item.id === id);
      const dependencies = new Set();
      const visit = dependencyId => {
        if (dependencies.has(dependencyId)) return;
        dependencies.add(dependencyId);
        for (const ancestor of software.modules.find(item => item.id === dependencyId)?.dependsOn || []) visit(ancestor);
      };
      for (const dependency of module.dependsOn || []) visit(dependency);
      // Dependencies are ordered before their consumers. Bind the actual registered
      // bytes as well as the structured contract: a Markdown-only change must
      // invalidate its consumers, while unrelated module reviews remain valid.
      let basisDigest = workspaceDigest([outlineBasis, outlineMaterial.sha256, module, [...dependencies].sort().map(dependencyId => {
        const dependency = workspace.modules.find(item => item.id === dependencyId);
        return { design: software.modules.find(item => item.id === dependencyId),
          sha256: workspace.materials[dependency.artifactId].sha256 };
      })]);
      // v3.12 reviews predate file-bound dependency bases. Preserve their
      // original Decision (never manufacture a new approval) only when the
      // exact old structural basis and every registered relevant byte match.
      const legacyBasis = workspaceDigest([outlineBasis, module,
        [...dependencies].sort().map(dependencyId => software.modules.find(item => item.id === dependencyId))]);
      const priorReview = previous?.reviews.find(item => item.decisionId === prior?.decisionId);
      const sameRegisteredMaterial = (oldTarget, newTarget) => oldTarget && newTarget &&
        previous.materials[oldTarget.artifactId]?.sha256 === workspace.materials[newTarget.artifactId]?.sha256;
      if (priorReview?.basisDigest === legacyBasis && sameRegisteredMaterial(previous.architecture, workspace.architecture) &&
          sameRegisteredMaterial(prior, { artifactId: moduleMaterial.artifactId }) &&
          [...dependencies].every(dependencyId => sameRegisteredMaterial(previous.modules.find(item => item.id === dependencyId),
            workspace.modules.find(item => item.id === dependencyId)))) basisDigest = legacyBasis;
      const review = detailed ? reviewFor(id, id, moduleMaterial, basisDigest, prior?.decisionId) : null;
      workspace.modules.push({ id, title: workspaceText(module.title || module.name || id, 160), purpose: workspaceText(module.purpose, 1000),
        detailed, artifactId: moduleMaterial.artifactId, decisionId: review?.decisionId || null,
        dependsOn: module.dependsOn || [], taskIds: module.taskIds || [] });
    }
    workspace.designVersion = workspaceVersion(workspaceDigest({ outlineBasis, materials: Object.values(workspace.materials).map(item => [item.artifactId, item.sha256]) }));
    const storedDesign = await repository.putBytes(runId, Buffer.from(JSON.stringify({ ...design, softwareDesign: software }, null, 2) + "\n"), "json");
    workspace.designRef = storedDesign;
    for (const request of workspace.requests) {
      const target = workspace.materials[request.artifactId];
      const currentTarget = request.targetId === "architecture" ? workspace.architecture : workspace.modules.find(module => module.id === request.targetId);
      const outdated = !target || request.version !== workspaceVersion(target.sha256) ||
        request.outlineBasis !== workspace.architecture.basisDigest || request.basisReviewId != null && request.basisReviewId !== currentTarget?.decisionId;
      if (outdated && request.status === "waiting_host") { request.status = "superseded"; request.updatedAt = at; }
      if (outdated && request.status === "host_claimed") { request.status = "in_doubt"; request.updatedAt = at; }
    }
    refreshProgress(workspace, at);
    const next = structuredClone(state);
    next.liveWorkspace = workspace;
    next.blockedOn = workspace.designStatus === "accepted" ? null : "live_design_review_pending";
    await repository.writeState(state, next);
    return { status: "design_registered", runId, revision: next.hostCheckpointRevision, designVersion: workspace.designVersion,
      nextAction: workspace.nextAction, ...nativeBoundary };
  }

  async function getOverview({ runId, cursor = null } = {}) {
    let state;
    try { state = await stateFor(runId); }
    catch (error) { if (error.code !== "workspace_current_run_unavailable") throw error; }
    return overviewForState(state, runId, cursor);
  }

  async function overviewForState(state, runId, cursor = null) {
    const stages = STAGE_ORDER.map(id => {
      const report = state?.hostStageReports?.[id], stage = state?.stages?.[id];
      const summary = typeof report?.summary === "string" ? report.summary : "";
      const allRefs = [...new Set([...(Array.isArray(report?.evidenceRefs) ? report.evidenceRefs : []),
        ...(Array.isArray(stage?.evidenceRefs) ? stage.evidenceRefs : [])].filter(ref => typeof ref === "string" && ref.length > 0))];
      const evidenceRefs = allRefs.filter(ref => ref.length <= policy.maxEvidenceRefChars).slice(0, policy.stageEvidenceLimit);
      return { id, label: STAGE_PUBLIC_LABELS[id], status: stage?.status || "not_observed", summary: workspaceText(summary, policy.stageSummaryChars),
        summaryTotalChars: summary.length, summaryTruncated: summary.length > policy.stageSummaryChars,
        evidenceLevel: report?.evidenceLevel || stage?.evidenceLevel || "not_observed", evidenceRefs,
        evidenceTotal: allRefs.length, evidenceOmitted: allRefs.length - evidenceRefs.length };
    });
    const base = { schemaVersion: LIVE_WORKSPACE_SCHEMA, projectId, runId, available: Boolean(state), revision: state ? state.hostCheckpointRevision || 0 : null,
      stages, design: { status: "not_registered", version: null, architecture: null, modules: [], totalModules: 0, nextCursor: null },
      reviews: [], requests: [], nextAction: null, capabilities: { review: { available: false, reason: "design_not_registered" },
        feedback: { available: false, reason: "design_not_registered" }, host: { available: false, mode: "current_host_pull", reason: "current_host_cli_consumes_requests" } },
      source: { kind: state?.archivedProjection ? "archived_spine_projection" : state ? "current_spine" : "current_spine_unavailable", version: state?.hostCheckpointRevision ?? null, truth: "owner_reported", recordOrigin: liveRecordOrigin(state) } };
    if (!state?.liveWorkspace) {
      const legacy = repository.readPublishedDesign ? await repository.readPublishedDesign(runId) : null;
      return legacy ? legacyOverview(base, legacy, cursor) : base;
    }
    const workspace = workspaceFor(state);
    const progress = deriveWorkspaceProgress(workspace, Date.parse(now()));
    let offset = 0;
    if (cursor) {
      let decoded;
      try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw workspaceFailure("workspace_cursor_invalid"); }
      workspaceRequire(decoded.version === workspace.designVersion && Number.isSafeInteger(decoded.offset) && decoded.offset >= 0 &&
        decoded.offset <= workspace.modules.length, "workspace_cursor_version_conflict", 409);
      offset = decoded.offset;
    }
    const selectedModules = progress.modules.slice(offset, offset + policy.modulePageSize);
    const ids = new Set([workspace.architecture.decisionId, ...selectedModules.map(module => module.decisionId).filter(Boolean)]);
    const invalidMaterials = new Set();
    // Global readiness/nextAction covers the complete design even when this
    // response contains only one module page. Hash checks do not load full
    // bodies into the response or discard any prior review records.
    for (const artifactId of new Set([workspace.architecture.artifactId, ...workspace.modules.map(module => module.artifactId)])) {
      try { await (repository.verifyMaterialForDisplay || repository.verifyMaterial)(workspace.materials[artifactId]); }
      catch (error) { if (["workspace_material_changed", "ENOENT", "workspace_material_path_untrusted"].includes(error.code)) invalidMaterials.add(artifactId); else throw error; }
    }
    // Propagate source drift only along dependency edges, including ancestors
    // outside this index page. Do not make an unrelated review unavailable.
    const affectedMaterials = new Set(invalidMaterials);
    for (const module of workspace.modules) {
      if (invalidMaterials.has(workspace.architecture.artifactId) ||
          module.dependsOn.some(id => affectedMaterials.has(workspace.modules.find(item => item.id === id).artifactId))) affectedMaterials.add(module.artifactId);
    }
    const descriptor = target => { const material = workspace.materials[target.artifactId];
      return { ...target, version: workspaceVersion(material.sha256), sha256: material.sha256,
        ...(affectedMaterials.has(target.artifactId) ? { status: "material_changed" } : {}) }; };
    const writable = state.active === true && state.conversationLinkState === "verified";
    const reviews = workspace.reviews.filter(review => ids.has(review.decisionId)).map(review => {
      const status = affectedMaterials.has(review.artifactId) ? "material_changed" : workspaceReviewState(review, Date.parse(now()));
      const target = progress.modules.find(module => module.id === review.moduleId);
      const dependenciesReady = !target || target.dependsOn.every(id => progress.modules.find(module => module.id === id)?.status === "accepted");
      const available = writable && status === "awaiting_human" && (review.kind === "outline" || dependenciesReady && progress.outlineStatus === "accepted" && !invalidMaterials.has(workspace.architecture.artifactId));
      return { decisionId: review.decisionId, revision: review.decision.revision, kind: review.kind, moduleId: review.moduleId,
        artifactId: review.artifactId, version: review.version, sha256: review.sha256, state: status,
        available, reason: available ? null : !writable ? "current_run_not_writable" : status !== "awaiting_human" ? status : !dependenciesReady ? "dependency_review_required" : "outline_review_required",
        options: policy.choices.map(choice => ({ ...choice })) };
    });
    const nextOffset = offset + selectedModules.length;
    const output = { ...base, design: { status: invalidMaterials.size ? "material_changed" : progress.designStatus,
      version: workspace.designVersion, architecture: descriptor({ ...workspace.architecture, status: progress.outlineStatus }),
      modules: selectedModules.map(descriptor), totalModules: workspace.modules.length,
      nextCursor: nextOffset < workspace.modules.length ? Buffer.from(JSON.stringify({ version: workspace.designVersion, offset: nextOffset })).toString("base64url") : null },
      reviews, requests: requestPage(state, workspace).requests, requestsTotal: workspace.requests.length,
      requestsNextCursor: requestPage(state, workspace).nextCursor, nextAction: invalidMaterials.size
        ? { kind: "refresh_design_material", stage: "thinking", summary: "材料已变化；请当前宿主重新登记准确版本" } : workspace.nextAction,
      capabilities: { ...base.capabilities, review: { available: writable, reason: writable ? null : "current_run_not_writable" },
        feedback: { available: writable, reason: writable ? null : "current_run_not_writable" } },
      source: { kind: state.archivedProjection ? "archived_spine_projection" : "spine_live_workspace", version: workspace.designVersion, truth: "owner_reported_with_local_human_review", recordOrigin: liveRecordOrigin(state) } };
    workspaceRequire(Buffer.byteLength(JSON.stringify(output)) <= policy.maxOverviewBytes, "workspace_overview_limit", 413);
    return output;
  }

  async function review(input) {
    checkNonce(input);
    const state = await stateFor(input.runId, { mutate: true });
    const workspace = structuredClone(workspaceFor(state));
    const digest = workspaceDigest({ kind: "review", input });
    const replay = priorRequest(workspace, input, digest);
    if (replay) return resultFor(replay, workspace, true);
    workspaceRequire(input.expectedWorkspaceRevision === (state.hostCheckpointRevision || 0), "workspace_revision_conflict", 409);
    workspaceRequire(policy.choices.some(choice => choice.id === input.choice), "workspace_choice_invalid");
    const current = workspace.reviews.find(item => item.decisionId === input.decisionId);
    workspaceRequire(current && current.artifactId === input.artifactId && current.version === input.version &&
      current.decision.revision === input.expectedRevision, "workspace_review_binding_conflict", 409);
    const target = current.kind === "outline" ? workspace.architecture : workspace.modules.find(module => module.id === current.moduleId);
    workspaceRequire(target?.decisionId === current.decisionId && workspaceReviewState(current, Date.parse(now())) === "awaiting_human", "workspace_review_not_current", 409);
    if (current.kind !== "outline") {
      const progress = deriveWorkspaceProgress(workspace);
      workspaceRequire(progress.outlineStatus === "accepted", "workspace_outline_review_required", 409);
      workspaceRequire(target.dependsOn.every(id => progress.modules.find(module => module.id === id)?.status === "accepted"), "workspace_dependency_review_required", 409);
    }
    const material = currentMaterial(workspace, input.artifactId, input.version);
    await repository.verifyMaterial(workspace.materials[workspace.architecture.artifactId]);
    await repository.verifyMaterial(material);
    if (current.kind !== "outline") await verifyDependencyMaterials(workspace, target);
    const at = now();
    const claim = buildLocalReviewClaim(current.decision, { source: "live_local_review",
      requestRef: `request:${workspaceDigest([input.runId, input.nonce])}`, claimRef: `claim:${digest}`,
      issuedAt: current.issuedAt, expiresAt: current.expiresAt, claimedAt: at,
      selectedOptionId: `option:${input.choice}`, answerDigest: workspaceVersion(digest) });
    current.decision = claimHostAnswer(current.decision, { at, claim });
    current.localReview = { source: "same_origin_live_ui", nonce: input.nonce, inputDigest: digest, consumedAt: at,
      nativeHostAuthenticated: false, executionAuthorized: false };
    const request = newRequest(workspace, { nonce: input.nonce, kind: "review", targetId: current.moduleId || "architecture",
      inputDigest: digest, summary: `${current.moduleId || "系统大纲"}：${policy.choices.find(choice => choice.id === input.choice).label}`,
      material, at, status: "recorded", decisionId: current.decisionId });
    refreshProgress(workspace, at);
    const next = structuredClone(state); next.liveWorkspace = workspace;
    next.blockedOn = workspace.designStatus === "accepted" ? null : "live_design_review_pending";
    return persistRequest(state, next, request, input, digest);
  }

  async function feedback(input) {
    checkNonce(input);
    workspaceRequire(typeof input.original === "string" && input.original.trim() && Buffer.byteLength(input.original) <= policy.maxFeedbackBytes,
      "workspace_feedback_limit", 413);
    const state = await stateFor(input.runId, { mutate: true });
    const workspace = structuredClone(workspaceFor(state));
    const digest = workspaceDigest({ kind: "feedback", input });
    const replay = priorRequest(workspace, input, digest);
    if (replay) return resultFor(replay, workspace, true);
    workspaceRequire(input.expectedWorkspaceRevision === (state.hostCheckpointRevision || 0), "workspace_revision_conflict", 409);
    const target = input.moduleId == null ? workspace.architecture : workspace.modules.find(module => module.id === input.moduleId);
    workspaceRequire(target && target.artifactId === input.artifactId, "workspace_feedback_target_conflict", 409);
    const material = currentMaterial(workspace, input.artifactId, input.version);
    await repository.verifyMaterial(material);
    const feedbackMaterial = await repository.putBytes(input.runId, Buffer.from(input.original), "text");
    const at = now();
    const review = workspace.reviews.find(item => item.decisionId === target.decisionId);
    if (review && review.decision.status !== "invalidated") review.decision = invalidateDecision(review.decision,
      { at, reasonRef: "reason:local-revision-request", evidence: [...review.decision.evidence,
        { evidenceRef: `feedback:${digest}`, digest: workspaceVersion(feedbackMaterial.sha256) }] });
    const request = newRequest(workspace, { nonce: input.nonce, kind: "feedback", targetId: input.moduleId || "architecture",
      inputDigest: digest, summary: "用户已提交完整修订意见，等待当前宿主接手", material, feedbackMaterial, at, basisReviewId: target.decisionId });
    refreshProgress(workspace, at, { enqueue: false });
    workspace.nextAction = { kind: "apply_feedback", stage: "thinking", moduleId: input.moduleId || null,
      commandId: request.commandId, summary: request.summary };
    const next = structuredClone(state); next.liveWorkspace = workspace; next.blockedOn = "live_design_revision_requested";
    return persistRequest(state, next, request, input, digest);
  }

  async function getRequests({ runId, commandId = null, nonce = null, cursor = null }) {
    const state = await stateFor(runId);
    const workspace = workspaceFor(state);
    if (commandId || nonce) {
      workspaceRequire(!cursor, "workspace_cursor_with_filter_invalid");
      const requests = workspace.requests.filter(request => (!commandId || request.commandId === commandId) && (!nonce || request.nonce === nonce));
      return { schemaVersion: "meta-kim-live-workspace-requests-v1", runId, revision: state.hostCheckpointRevision || 0,
        requests: requests.toReversed().map(publicRequest), total: requests.length, nextCursor: null, order: "newest_first" };
    }
    return { schemaVersion: "meta-kim-live-workspace-requests-v1", runId, ...requestPage(state, workspace, cursor) };
  }

  async function hostInspect({ runId, conversationId }) {
    const state = await stateFor(runId, { mutate: true });
    assertHost(state, conversationId, state.hostCheckpointRevision || 0);
    const workspace = state.liveWorkspace ? workspaceFor(state) : null;
    const page = workspace ? requestPage(state, workspace) : { requests: [], total: 0, nextCursor: null };
    const current = workspace ? await overviewForState(state, runId) : null;
    return { runId, profile: repository.profile, revision: state.hostCheckpointRevision || 0, stage: state.currentStage,
      designStatus: current?.design.status || "not_registered", nextAction: current?.nextAction || null,
      requests: page.requests, requestsTotal: page.total, requestsTruncated: page.nextCursor !== null, requestsNextCursor: page.nextCursor,
      boundedRequestRead: workspace ? { hostEntry: workspace.hostEntry,
        arguments: ["--project-root", repository.projectRoot, "--profile", repository.profile, "--run-id", runId,
          "--conversation-id", conversationId, "--list-requests", ...(page.nextCursor ? ["--cursor", page.nextCursor] : [])] } : null,
      ...nativeBoundary };
  }

  async function claimRequest({ runId, conversationId, expectedRevision, commandId }) {
    const state = await stateFor(runId, { mutate: true, expectedRevision });
    assertHost(state, conversationId, expectedRevision);
    const workspace = structuredClone(workspaceFor(state));
    const request = workspace.requests.find(item => item.commandId === commandId);
    workspaceRequire(request && request.status === "waiting_host", "workspace_request_not_claimable", 409);
    workspaceRequire(!workspace.requests.some(item => item.commandId !== commandId && item.targetId === request.targetId &&
      ["host_claimed", "in_doubt"].includes(item.status)), "workspace_target_has_unresolved_claim", 409);
    workspaceRequire(request.outlineBasis === workspace.architecture.basisDigest, "workspace_request_scope_changed", 409);
    if (["design_module", "revise_module"].includes(request.kind)) {
      const progress = deriveWorkspaceProgress(workspace);
      workspaceRequire(progress.outlineStatus === "accepted", "workspace_outline_review_required", 409);
      const target = workspace.modules.find(module => module.id === request.targetId);
      workspaceRequire(target && target.dependsOn.every(id => progress.modules.find(module => module.id === id)?.status === "accepted"),
        "workspace_dependency_review_required", 409);
    }
    if (request.kind === "continue_governed_run") {
      workspaceRequire(deriveWorkspaceProgress(workspace, Date.parse(now())).designStatus === "accepted", "workspace_design_review_pending", 409);
      // Continuing the spine consumes the entire accepted design, not only
      // the outline material carried by the generated work order.
      for (const module of workspace.modules) await repository.verifyMaterial(workspace.materials[module.artifactId]);
    }
    const material = currentMaterial(workspace, request.artifactId, request.version);
    await repository.verifyMaterial(workspace.materials[workspace.architecture.artifactId]);
    await repository.verifyMaterial(material);
    if (["design_module", "revise_module"].includes(request.kind)) await verifyDependencyMaterials(workspace,
      workspace.modules.find(module => module.id === request.targetId) || {});
    const claimToken = randomBytes(32).toString("base64url");
    const at = now();
    request.status = "host_claimed"; request.updatedAt = at;
    request.claim = { tokenSha256: workspaceBytesDigest(Buffer.from(claimToken)), conversationDigest: workspaceDigest(conversationId),
      claimedAt: at, expiresAt: new Date(Date.parse(at) + policy.hostLeaseMs).toISOString() };
    const next = structuredClone(state); next.liveWorkspace = workspace;
    await repository.writeState(state, next);
    return { status: "host_claimed", commandId, claimToken, revision: next.hostCheckpointRevision,
      workOrder: { runId, kind: request.kind, targetId: request.targetId, sourceVersion: request.version,
        material: { ref: material.ref, sha256: material.sha256, bytes: material.bytes },
        boundedMaterialRead: { entrypoint: workspace.hostEntry, arguments: ["--project-root", repository.projectRoot,
          "--profile", repository.profile, "--run-id", runId, "--conversation-id", conversationId,
          "--read-material", "--artifact-id", material.artifactId, "--version", workspaceVersion(material.sha256)] },
        ...(request.feedbackMaterial ? { feedback: { ...request.feedbackMaterial } } : {}),
        design: { ref: workspace.designRef.ref, sha256: workspace.designRef.sha256 },
        nextAction: workspace.nextAction, instruction: "Read only the bound material and required design sections. Perform the requested work in the current host; publish changed design in Thinking, then report actual file evidence. A claim is not execution proof." }, ...nativeBoundary };
  }

  async function completeRequest({ runId, conversationId, expectedRevision, commandId, claimToken, input }) {
    const state = await stateFor(runId, { mutate: true });
    assertHost(state, conversationId, state.hostCheckpointRevision || 0);
    const workspace = structuredClone(workspaceFor(state));
    const request = workspace.requests.find(item => item.commandId === commandId);
    workspaceRequire(request && request.claim && typeof claimToken === "string" &&
      request.claim.tokenSha256 === workspaceBytesDigest(Buffer.from(claimToken)) && request.claim.conversationDigest === workspaceDigest(conversationId),
      "workspace_host_claim_conflict", 409);
    workspaceRequire(object(input) && ["produced", "blocked", "no_change"].includes(input.outcome) && typeof input.summary === "string" && input.summary.trim() &&
      input.summary.length <= 4000 && Array.isArray(input.evidenceRefs) && input.evidenceRefs.length > 0 && input.evidenceRefs.length <= 32,
      "workspace_host_receipt_invalid");
    const digest = workspaceDigest(input);
    if (request.status === "host_reported") {
      workspaceRequire(request.receiptDigest === digest, "workspace_host_receipt_replay_conflict", 409);
      return { status: "host_reported", commandId, replay: true, ...nativeBoundary };
    }
    assertHost(state, conversationId, expectedRevision);
    workspaceRequire(["host_claimed", "in_doubt"].includes(request.status), "workspace_host_receipt_state_conflict", 409);
    for (const evidence of input.evidenceRefs) {
      workspaceRequire(object(evidence) && /^[a-f0-9]{64}$/u.test(evidence.sha256 || ""), "workspace_host_evidence_invalid");
      await repository.inspect(evidence.ref, evidence.sha256);
    }
    request.status = "host_reported"; request.updatedAt = now(); request.receiptDigest = digest;
    request.outcome = input.outcome; request.summary = workspaceText(input.summary);
    request.receiptMaterial = await repository.putBytes(runId, Buffer.from(JSON.stringify(input) + "\n"), "json");
    request.receipt = { evidenceLevel: "host_reported_files_verified", evidenceCount: input.evidenceRefs.length,
      evidenceRefs: input.evidenceRefs.map(({ ref, sha256 }) => ({ ref, sha256 })), ...nativeBoundary };
    const next = structuredClone(state); next.liveWorkspace = workspace;
    await repository.writeState(state, next);
    return { status: "host_reported", commandId, revision: next.hostCheckpointRevision, replay: false, ...nativeBoundary };
  }

  return { policy, repository, getOverview, review, feedback, getRequests, publishDesign, hostInspect, claimRequest, completeRequest,
    async getMaterial({ runId, artifactId, version, cursor }) {
      let state;
      try { state = await stateFor(runId); } catch (error) { if (error.code !== "workspace_current_run_unavailable") throw error; }
      if (!state?.liveWorkspace) {
        const legacy = repository.readPublishedDesign ? await repository.readPublishedDesign(runId) : null;
        workspaceRequire(legacy, "workspace_material_unknown", 404);
        const rows = legacyRows(runId, legacy);
        const material = [rows.architecture, ...rows.modules].find(item => item.artifactId === artifactId);
        workspaceRequire(material && material.version === version, "workspace_material_version_conflict", 409);
        let offset = 0;
        if (cursor) {
          let decoded;
          try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw workspaceFailure("workspace_cursor_invalid"); }
          workspaceRequire(decoded.artifactId === artifactId && decoded.version === version && Number.isSafeInteger(decoded.offset) && decoded.offset >= 0,
            "workspace_cursor_version_conflict", 409); offset = decoded.offset;
        }
        workspaceRequire(offset <= material.bytes.length, "workspace_cursor_invalid");
        let end = Math.min(material.bytes.length, offset + policy.materialPageBytes);
        while (end > offset && end < material.bytes.length && (material.bytes[end] & 0xc0) === 0x80) end -= 1;
        let text;
        try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(material.bytes.subarray(offset, end)); }
        catch { throw workspaceFailure("workspace_cursor_invalid"); }
        const eof = end >= material.bytes.length;
        return { schemaVersion: "meta-kim-live-workspace-material-v1", artifactId, version, sha256: material.sha256, format: "json", text,
          totalBytes: material.bytes.length, eof, sourceState: "current", nextCursor: eof ? null
            : Buffer.from(JSON.stringify({ artifactId, version, offset: end })).toString("base64url") };
      }
      const workspace = workspaceFor(state);
      const current = workspace.materials[artifactId];
      if (!current || version !== workspaceVersion(current.sha256)) {
        const review = workspace.reviews.find(item => item.artifactId === artifactId && item.version === version);
        workspaceRequire(review, "workspace_material_version_conflict", 409);
        const historical = await repository.historicalReviewMaterial(runId, review);
        return { ...await repository.materialPage(historical, { version, cursor }), historical: true, current: false, sourceState: "snapshot_only" };
      }
      return repository.materialPage(currentMaterial(workspace, artifactId, version), { version, cursor });
    },
  };
}
