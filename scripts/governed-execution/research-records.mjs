import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { inspectTrustedPath } from "../safe-managed-file-operations.mjs";

const text = value => typeof value === "string" && value.trim().length > 0;
const list = value => Array.isArray(value) && value.every(text);
const requireThat = (value, reason) => { if (!value) throw new TypeError(reason); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const validDate = value => text(value) && Number.isFinite(Date.parse(value));
const policy = JSON.parse(readFileSync(new URL("../../config/contracts/core-loop-contract.json", import.meta.url), "utf8")).projectResearchPolicy;

/** Normalize host-collected evidence once. Source declarations are reviewable
 * records, not proof that a browser, repository or model was actually invoked. */
export function normalizeResearchEvidence({ input = null, taskHash, intentDigest = null, now = Date.now() } = {}) {
  if (input == null) return null;
  requireThat([1, policy.recordSchemaVersion].includes(input.schemaVersion) && input.taskHash === taskHash && (input.intentDigest ?? null) === intentDigest, "Research must bind the current task and intent");
  requireThat(typeof input.required === "boolean" && Array.isArray(input.topics) && Array.isArray(input.sources), "Research requires topics, sources and applicability");
  const seen = new Set();
  const sources = input.sources.map(source => {
    requireThat(text(source.id) && !seen.has(source.id), "Research source IDs must be unique"); seen.add(source.id);
    requireThat(["github", "official", "product", "case", "paper", "web"].includes(source.kind) && text(source.url) && validDate(source.observedAt), "Research source needs kind, URL and observation time");
    const url = new URL(source.url);
    requireThat(url.protocol === "https:" && !url.username && !url.password, "Research source URL must be public HTTPS");
    requireThat(text(source.relevance) && text(source.findings) && text(source.adaptation), "Research source needs relevance, findings and adaptation limits");
    requireThat(Date.parse(source.observedAt) <= now, "Research observation cannot be in the future");
    const record = { id: source.id, kind: source.kind, url: source.url, observedAt: source.observedAt,
      relevance: source.relevance, findings: source.findings, adaptation: source.adaptation };
    if (source.expiresAt != null) {
      requireThat(validDate(source.expiresAt) && Date.parse(source.expiresAt) >= Date.parse(source.observedAt), "Research expiry must follow its observation");
      record.expiresAt = source.expiresAt;
    }
    if (source.kind === "github") {
      const parts = url.pathname.split("/").filter(Boolean);
      requireThat(url.hostname === "github.com" && parts.length >= 2 && (source.stars == null || Number.isSafeInteger(source.stars) && source.stars >= 0)
        && /^[a-f0-9]{40}$/i.test(source.revision ?? ""), "GitHub research needs repository, observed stars and exact revision");
      Object.assign(record, { repository: parts.slice(0, 2).join("/").toLowerCase(), ...(source.stars != null ? { stars: source.stars } : {}), revision: source.revision });
    } else if (source.revision != null) {
      requireThat(text(source.revision), "Official source revision must be text"); record.revision = source.revision;
    }
    return record;
  });
  const topicIds = new Set();
  const gaps = [];
  const constraints = input.constraints == null ? null : structuredClone(input.constraints);
  if (constraints) {
    requireThat(list(constraints.evidenceRefs) && constraints.evidenceRefs.length > 0, "Explicit research constraints require current user evidence");
    for (const key of ["minimumSources", "minimumGithubRepositories", "minimumObservedStars"]) {
      requireThat(constraints[key] == null || Number.isSafeInteger(constraints[key]) && constraints[key] >= 0, "Invalid explicit research constraint");
    }
    requireThat(constraints.requiredChannels == null || list(constraints.requiredChannels), "Explicit query channels must be a list");
  }
  const topics = input.topics.map(topic => {
    requireThat(text(topic.id) && !topicIds.has(topic.id), "Research topic IDs must be unique"); topicIds.add(topic.id);
    requireThat(text(topic.question) && list(topic.keywords) && topic.keywords.length > 0 && list(topic.sourceIds)
      && Array.isArray(topic.queries) && list(topic.decisionRefs ?? []), "Research topic needs question, keywords, queries and source references");
    requireThat(topic.sourceIds.every(id => seen.has(id)), "Research topic references an unknown source ID");
    const queries = [...new Map(topic.queries.map(query => {
      requireThat(topic.keywords.includes(query.keyword) && ["web", "github", "official", "product", "paper", "case"].includes(query.channel) && text(query.query)
        && validDate(query.observedAt) && Date.parse(query.observedAt) <= now, "Research query needs a declared keyword, channel, text and observed time");
      return [JSON.stringify([query.keyword, query.channel, query.query]), { keyword: query.keyword, channel: query.channel,
        query: query.query, observedAt: query.observedAt }];
    })).values()];
    for (const keyword of topic.keywords) for (const channel of constraints?.requiredChannels ?? []) {
      if (!queries.some(query => query.keyword === keyword && query.channel === channel)) gaps.push(`keyword_query_missing:${topic.id}:${keyword}:${channel}`);
    }
    const legacy = input.schemaVersion === 1;
    if (!legacy) requireThat(text(topic.decisionImpact) && ["resolved", "unresolved", "conflicting", "not_applicable"].includes(topic.status), "Research topic needs its decision impact and assessment status");
    if (!legacy && topic.status === "resolved") requireThat(text(topic.conclusion), "Resolved research requires a source-backed conclusion");
    if (!legacy && topic.status === "not_applicable") requireThat(text(topic.notApplicableReason), "Inapplicable research needs a concrete reason");
    if (legacy) gaps.push(`legacy_topic_decision_review_required:${topic.id}`);
    else if (["unresolved", "conflicting"].includes(topic.status)) gaps.push(`decision_evidence_${topic.status}:${topic.id}`);
    if (topic.status !== "not_applicable" && !topic.sourceIds.length) gaps.push(`topic_sources_missing:${topic.id}`);
    for (const source of sources.filter(source => topic.sourceIds.includes(source.id))) {
      if (source.expiresAt && Date.parse(source.expiresAt) < now) gaps.push(`research_source_expired:${source.id}`);
    }
    return { id: topic.id, question: topic.question, keywords: [...new Set(topic.keywords)], queries,
      sourceIds: [...new Set(topic.sourceIds)], decisionRefs: [...new Set(topic.decisionRefs ?? [])],
      decisionImpact: legacy ? "Current decision review required for legacy evidence" : topic.decisionImpact,
      status: legacy ? "unresolved" : topic.status, ...(topic.conclusion ? { conclusion: topic.conclusion } : {}),
      ...(topic.notApplicableReason ? { notApplicableReason: topic.notApplicableReason } : {}) };
  });
  if (input.required && !topics.length) gaps.push("research_topics_missing");
  const referenced = new Set(topics.flatMap(topic => topic.sourceIds));
  const currentSources = sources.filter(source => referenced.has(source.id) && (!source.expiresAt || Date.parse(source.expiresAt) >= now));
  const accepted = currentSources.filter(source => source.kind === "github" && (constraints?.minimumObservedStars == null || source.stars >= constraints.minimumObservedStars));
  const repositories = [...new Set(accepted.map(source => source.repository))];
  if (constraints?.minimumSources != null && currentSources.length < constraints.minimumSources) gaps.push("explicit_minimum_sources_unmet");
  if (constraints?.minimumGithubRepositories != null && repositories.length < constraints.minimumGithubRepositories) gaps.push("explicit_minimum_github_repositories_unmet");
  for (const source of currentSources) if (source.kind === "github" && constraints?.minimumObservedStars != null && !(source.stars >= constraints.minimumObservedStars)) gaps.push(`explicit_star_floor_unmet:${source.id}`);
  const normalized = { schemaVersion: policy.recordSchemaVersion, taskHash, intentDigest, required: input.required, topics, sources, ...(constraints ? { constraints } : {}) };
  return { ...normalized, digest: digest(normalized), matchingRepositoryCount: repositories.length, gaps: [...new Set(gaps)], readiness: gaps.length ? "research_incomplete" : "ready",
    claimBoundary: "Host-provided source records; metadata and summaries do not authenticate external invocation or semantic fitness" };
}

/** Immutable evidence is separate from the PRD/queue; waiting and later runs can
 * reread this exact record without carrying all research in model context. */
export async function persistResearchEvidence({ research, outputDir, projectRoot }) {
  if (!research) return null;
  const recordRef = path.relative(projectRoot, path.join(outputDir, `research-${research.digest}.json`)).split(path.sep).join("/");
  const checked = inspectTrustedPath(projectRoot, recordRef, { allowMissing: true });
  requireThat(checked, "Research storage must stay inside the trusted project without symlinks");
  const file = checked.target;
  const { schemaVersion, taskHash, intentDigest, required, topics, sources, constraints, digest: researchDigest } = research;
  requireThat(schemaVersion === policy.recordSchemaVersion, "Legacy research is read-only; write a reviewed current successor");
  const content = JSON.stringify({ schemaVersion, taskHash, intentDigest, required, topics, sources, ...(constraints ? { constraints } : {}), digest: researchDigest }, null, 2) + "\n";
  await fs.mkdir(outputDir, { recursive: true });
  requireThat(inspectTrustedPath(projectRoot, recordRef, { allowMissing: true }), "Research storage path changed");
  try { await fs.writeFile(file, content, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    requireThat(await fs.readFile(file, "utf8") === content, "Existing research evidence changed; preserve and review it");
  }
  return { ...research, recordRef,
    recordSha256: createHash("sha256").update(content).digest("hex") };
}

export function researchForTask({ research, sourceIds = [] }) {
  if (!sourceIds.length) return [];
  requireThat(research && sourceIds.every(id => research.sources.some(source => source.id === id)), "Task references unknown research evidence");
  return [...new Set(sourceIds)].map(id => {
    const source = research.sources.find(item => item.id === id);
    return { sourceId: id, url: source.url, ...(source.revision ? { revision: source.revision } : {}),
      summary: source.findings, relevance: source.relevance, adaptation: source.adaptation,
      recordRef: research.recordRef ?? null, recordSha256: research.recordSha256 ?? null, researchDigest: research.digest };
  });
}

/** A worker can reopen only its selected entries and verify the immutable bytes. */
export async function readTaskResearchEvidence({ projectRoot, evidence, taskHash, intentDigest, now = Date.now() }) {
  requireThat(Array.isArray(evidence) && evidence.length > 0, "Select research source references before rereading");
  requireThat(text(taskHash) && (intentDigest === null || text(intentDigest)), "Current task and intent binding required to reread research");
  const records = new Map();
  for (const item of evidence) {
    requireThat(text(item.recordRef) && /^[a-f0-9]{64}$/u.test(item.recordSha256 ?? ""), "Task research requires a persisted record binding");
    if (!records.has(item.recordRef)) {
      const checked = inspectTrustedPath(projectRoot, item.recordRef);
      requireThat(checked, "Research record must stay inside the trusted project without symlinks");
      const content = await fs.readFile(checked.target, "utf8");
      requireThat(createHash("sha256").update(content).digest("hex") === item.recordSha256, "Persisted research bytes changed");
      const record = JSON.parse(content);
      requireThat(record.taskHash === taskHash && (record.intentDigest ?? null) === intentDigest, "Research must bind the current task and intent");
      if (record.schemaVersion === 1) {
        const { schemaVersion, taskHash: originalTask, intentDigest: originalIntent, required, topics, sources } = record;
        requireThat(digest({ schemaVersion, taskHash: originalTask, intentDigest: originalIntent, required, topics, sources }) === record.digest, "Legacy research digest mismatch");
        throw new TypeError("Legacy research needs current decision review before dispatch; preserve its immutable record");
      }
      const normalized = normalizeResearchEvidence({ input: record, taskHash, intentDigest, now });
      requireThat(normalized.digest === record.digest && normalized.digest === item.researchDigest, "Persisted research digest mismatch");
      records.set(item.recordRef, { ...normalized, recordRef: item.recordRef, recordSha256: item.recordSha256 });
    }
    const record = records.get(item.recordRef);
    requireThat(record.recordSha256 === item.recordSha256 && record.digest === item.researchDigest, "Task research record bindings disagree");
    requireThat(digest(researchForTask({ research: record, sourceIds: [item.sourceId] })[0]) === digest(item), "Task research summary differs from its stored source");
    const topics = record.topics.filter(topic => topic.sourceIds.includes(item.sourceId));
    requireThat(topics.length > 0 && topics.every(topic => topic.status === "resolved" || topic.status === "not_applicable"), "Selected research still has unresolved or conflicting decision evidence; return to Fetch");
    requireThat(!record.gaps.some(gap => gap.startsWith("explicit_") || gap.startsWith("keyword_query_missing:")), "Explicit task research constraints are not satisfied");
    const source = record.sources.find(source => source.id === item.sourceId);
    requireThat(!source.expiresAt || Date.parse(source.expiresAt) >= now, "Selected research source expired; return to Fetch");
  }
  return evidence.map(item => structuredClone(records.get(item.recordRef).sources.find(source => source.id === item.sourceId)));
}
