#!/usr/bin/env node
/** Bounded, read-only queries over the existing source-aware capability inventory. */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { sanitizeCapabilityPublicationText } from "./capability-publication-sanitizer.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TYPES = ["agents", "skills", "commands", "mcpTools", "runtimeTools", "mcpServers", "hooks", "plugins", "rules", "prompts"];
const RUNTIMES = ["all", "claude", "codex", "codexapp", "cursor", "openclaw"];
const STOP_WORDS = new Set("a an the and or for to in on with of this that please help me find need use using from by".split(" "));
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const string = (value) => typeof value === "string" ? value : "";
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const normalized = (value) => string(value).normalize("NFKC").toLowerCase().replace(/[\u0000-\u001f\u007f]/gu, " ");
const runtimeId = (value) => ({ claudecode: "claude" }[normalized(value)] || normalized(value));

function checkedOptions(options) {
  const query = string(options.query).normalize("NFKC").trim();
  if (!query || query.length > 512) throw new Error("query must contain 1 to 512 characters");
  const keywords = options.keywords || [];
  if (!Array.isArray(keywords) || keywords.length > 8 || keywords.some((word) => !string(word).trim() || word.length > 128)) throw new Error("invalid keywords: at most 8 nonempty values of 128 characters");
  const runtime = runtimeId(options.runtime || "all");
  if (!RUNTIMES.includes(runtime)) throw new Error("invalid runtime");
  const aliases = { agent: "agents", skill: "skills", command: "commands", tool: "tools", hook: "hooks", plugin: "plugins", mcptools: "mcpTools", mcpservers: "mcpServers", runtimetools: "runtimeTools" };
  const rawType = string(options.type || "all").toLowerCase();
  const type = aliases[rawType] || rawType;
  if (!["all", "tools", ...TYPES].includes(type)) throw new Error("invalid capability type");
  const limit = options.limit === undefined ? 8 : Number(options.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new Error("limit must be an integer from 1 to 25");
  const profile = options.profile || "default";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(profile) || [".", ".."].includes(profile)) throw new Error("invalid profile");
  const terms = new Set();
  for (const token of normalized([query, ...keywords].join(" ")).match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]*/gu) || []) {
    if (STOP_WORDS.has(token)) continue;
    terms.add(token);
    if (/^\p{Script=Han}{3,}$/u.test(token)) {
      const chars = [...token];
      for (let i = 0; i < chars.length - 1; i += 1) terms.add(chars.slice(i, i + 2).join(""));
    }
  }
  if (!terms.size) throw new Error("query contains no searchable capability terms");
  return { query, keywords, runtime, type, limit, profile, terms: [...terms].slice(0, 64) };
}

async function readIndex(file, registryName, now, publish) {
  const source = { sourceRef: publish(file, 1024).replace(/\\/gu, "/"), registryName, state: "invalid", generatedAt: null, reason: null };
  let handle;
  try {
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) throw new Error("not_plain_or_bounded_inventory");
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev || info.size > MAX_BYTES) throw new Error("inventory_changed");
    const buffer = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await handle.stat();
    if (count !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error("inventory_changed");
    const value = JSON.parse(buffer.subarray(0, count).toString("utf8"));
    if (!object(value) || value.registryName !== registryName || !object(value.byCapabilityType)) throw new Error("unsupported_inventory_shape");
    const generated = Date.parse(value.generatedAt);
    if (typeof value.generatedAt !== "string" || !Number.isFinite(generated)) throw new Error("invalid_inventory_timestamp");
    source.generatedAt = new Date(generated).toISOString();
    source.state = generated > now + 300000 ? "clock_skew" : now - generated > MAX_AGE_MS ? "stale" : "fresh";
    if (source.state !== "fresh") source.reason = source.state === "stale" ? "cache_older_than_7_days" : "cache_timestamp_in_future";
    return { source, value };
  } catch (error) {
    source.state = error.code === "ENOENT" ? "missing" : "invalid";
    source.reason = error.code === "ENOENT" ? "inventory_not_found" : error instanceof SyntaxError ? "invalid_json" : "inventory_unreadable_or_invalid";
    return { source, value: null };
  } finally { await handle?.close(); }
}

function candidatesFrom(index, options, publish) {
  const rows = [];
  for (const type of TYPES) {
    if (options.type !== "all" && options.type !== type && !(options.type === "tools" && ["mcpTools", "runtimeTools"].includes(type))) continue;
    for (const [qualifiedId, record] of Object.entries(index.value?.byCapabilityType?.[type] || {})) {
      if (!object(record) || !string(record.id)) continue;
      const canonical = index.source.registryName === "meta-kim-capabilities";
      const runtimes = record.platformId ? [runtimeId(record.platformId)]
        : Array.isArray(record.runtimeTargets) && record.runtimeTargets.length ? record.runtimeTargets.map(runtimeId) : ["unspecified"];
      for (const runtime of [...new Set(runtimes)]) {
        if (runtime !== "unspecified" && (!RUNTIMES.includes(runtime) || runtime === "all")) continue;
        if (options.runtime !== "all" && runtime !== options.runtime) continue;
        const metadata = object(record.metadata) ? record.metadata : {};
        const sourceRef = publish(record.sourceRef || record.path || qualifiedId, 1024).replace(/\\/gu, "/");
        const sourceKey = publish(record.sourceKey || `${runtime}:${type}:${qualifiedId}:${sourceRef}`, 1536);
        const candidate = { id: publish(record.id, 160), qualifiedId: publish(record.qualifiedId || qualifiedId, 256), type, runtime,
          nativeIdentity: publish(record.nativeIdentity || record.id, 160), name: publish(metadata.name || record.name || record.id, 160),
          description: publish(metadata.description || record.description || "", 600), sourceRef, sourceKey,
          sourceClass: publish(record.sourceClass || (canonical ? "canonical" : "unknown"), 64),
          providerId: publish(record.providerId || metadata.providerId || "", 160) || null,
          providerKind: publish(record.providerKind || metadata.providerKind || "", 96) || null,
          namespace: publish(record.namespace || "", 128) || null,
          sourceValid: typeof record.sourceValid === "boolean" ? record.sourceValid : null,
          routeEligible: typeof record.routeEligible === "boolean" ? record.routeEligible : null,
          executionBlock: record.executionBlock === true,
          validCustomAgentDefinition: metadata.validCustomAgentDefinition === true,
          collision: { kind: publish(record.collision?.kind || "none", 64), ambiguous: record.collision?.ambiguous === true || record.ambiguousNativeIdentity === true,
            candidateCount: Number.isSafeInteger(record.collision?.candidateCount) ? record.collision.candidateCount : 1,
            winnerSourceKey: publish(record.collision?.winnerSourceKey || record.sourceKey || "", 1536) || null },
          collisionAliases: (Array.isArray(record.collisionAliases) ? record.collisionAliases : []).slice(0, 16).map((item) => publish(item, 1536)),
          provenance: (Array.isArray(record.provenance) ? record.provenance : []).slice(0, 16).filter(object).map((entry) => ({
            sourceRef: publish(entry.sourceRef || "", 1024).replace(/\\/gu, "/"), sourceKey: publish(entry.sourceKey || "", 1536),
            sourceClass: publish(entry.sourceClass || "", 64), sourceValid: typeof entry.sourceValid === "boolean" ? entry.sourceValid : null,
            contentDigest: /^[a-f0-9]{64}$/u.test(entry.contentDigest || "") ? entry.contentDigest : null,
          })),
          inventoryState: index.source.state, inventoryGeneratedAt: index.source.generatedAt,
          availability: "cached_candidate", qualification: "not_assessed", invocationState: "not_invoked" };
        rows.push({ candidate, winner: record.selectedAsWinner === true,
          // Deduplicate original identities, never redacted display strings: two
          // private source paths may publish the same placeholder but are distinct.
          group: `${type}:${runtime}:${[record.routesToSourceKey, record.sourceKey, record.sourceRef, record.path, qualifiedId].find((value) => typeof value === "string" && value)}`,
          fields: { name: normalized([candidate.id, candidate.nativeIdentity, candidate.name].join(" ")),
            description: normalized(metadata.description || record.description || "").slice(0, 4000),
            keywords: normalized([metadata._keywords, metadata.trigger, ...(Array.isArray(record.keywords) ? record.keywords : [])].filter((item) => typeof item === "string").join(" ")).slice(0, 4000) } });
      }
    }
  }
  return rows;
}

/** Query only two explicit indexes. A match is neither provider qualification nor invocation evidence. */
export async function searchCapabilities(options = {}) {
  const checked = checkedOptions(options);
  const homeDir = options.homeDir || os.homedir();
  const repoRoot = options.repoRoot || packageRoot;
  const publish = (value, max) => sanitizeCapabilityPublicationText(string(value), { homeDir, repoRoot }).replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, max);
  const inventoryPath = options.inventoryPath || path.join(homeDir, ".meta-kim", "state", checked.profile, "capability-index", "global-capabilities.json");
  const canonicalPath = options.canonicalPath || path.join(repoRoot, "config/capability-index/meta-kim-capabilities.json");
  const now = options.now === undefined ? Date.now() : Date.parse(options.now);
  if (!Number.isFinite(now)) throw new Error("invalid query timestamp");
  const indexes = await Promise.all([readIndex(inventoryPath, "global-capabilities", now, publish), readIndex(canonicalPath, "meta-kim-capabilities", now, publish)]);
  const groups = new Map();
  for (const row of indexes.flatMap((index) => candidatesFrom(index, checked, publish))) {
    const previous = groups.get(row.group);
    if (!previous || Number(row.winner) > Number(previous.winner)
      || (row.winner === previous.winner && compare(row.candidate.sourceKey, previous.candidate.sourceKey) < 0)) groups.set(row.group, row);
  }
  const ranked = [];
  for (const { candidate, fields } of groups.values()) {
    const matches = checked.terms.map((term) => ({ term, fields: Object.keys(fields).filter((field) => fields[field].includes(term)) })).filter((match) => match.fields.length);
    if (!matches.length) continue;
    const relevanceScore = matches.reduce((sum, match) => sum + Math.max(...match.fields.map((field) => ({ name: 12, description: 8, keywords: 3 }[field]))), 0);
    ranked.push({ ...candidate, relevanceScore, matchedTerms: matches.map((match) => publish(match.term, 128)),
      matchedFields: [...new Set(matches.flatMap((match) => match.fields))], matchCoverage: { matched: matches.length, queried: checked.terms.length } });
  }
  ranked.sort((a, b) => b.relevanceScore - a.relevanceScore || compare(a.qualifiedId, b.qualifiedId) || compare(a.sourceKey, b.sourceKey));
  const refreshRuntime = checked.runtime === "claude" ? "claudeCode" : checked.runtime;
  return { schemaVersion: "meta-kim-capability-search-v1", status: ranked.length ? "candidates" : "capability_gap",
    query: publish(checked.query, 512), keywords: checked.keywords.map((word) => publish(word, 128)), runtime: checked.runtime, type: checked.type, limit: checked.limit,
    sources: indexes.map((index) => index.source), totalMatches: ranked.length, candidates: ranked.slice(0, checked.limit),
    gap: ranked.length ? null : { capabilityNeed: publish(checked.query, 512), reason: indexes[0].value ? "no_matching_cached_capability" : "inventory_unavailable",
      nextAction: indexes[0].value ? "refine_keywords_or_record_capability_gap" : "refresh_existing_inventory" },
    refreshCommand: `npm run discover:global -- --runtime-inventory-only${checked.runtime === "all" ? "" : ` --targets ${refreshRuntime}`}`,
    boundary: "Cached relevance only. Scores are not safety qualifications or an 85-point admission gate. Candidates have not been selected, invoked, installed or created; inspect the source and verify actual host invocation separately." };
}

function parseArgs(args) {
  const options = { keywords: [] };
  const names = { query: "query", runtime: "runtime", type: "type", limit: "limit", inventory: "inventoryPath", canonical: "canonicalPath", profile: "profile" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") { options.json = true; continue; }
    const match = arg.match(/^--([a-z-]+)(?:=(.*))?$/u);
    if (!match || (!names[match[1]] && match[1] !== "keyword")) throw new Error(`invalid search option: ${arg}`);
    const value = match[2] ?? args[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value: --${match[1]}`);
    if (match[1] === "keyword") options.keywords.push(value);
    else { if (options[names[match[1]]] !== undefined) throw new Error(`duplicate option: --${match[1]}`); options[names[match[1]]] = value; }
  }
  const cwd = process.env.META_KIM_CALLER_CWD || process.cwd();
  for (const field of ["inventoryPath", "canonicalPath"]) if (options[field]) options[field] = path.resolve(cwd, options[field]);
  return options;
}

async function main() {
  if (process.argv.slice(2).some((arg) => ["--help", "-h"].includes(arg))) {
    console.log("Usage: meta-kim capability search --query <capability need> [--runtime codex|claude|cursor|openclaw|codexapp|all] [--type agents|skills|commands|tools|all] [--keyword <extra term>] [--limit 1..25] [--profile default] [--inventory <cache.json>] [--canonical <index.json>] [--json]\nReads existing indexes only; never scans, installs, selects or invokes a provider. Use --keyword repeatedly for domain terms or translated synonyms. Old/missing cache is disclosed with its refresh command.");
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const result = await searchCapabilities(options);
  if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`${result.status}: ${result.candidates.length}/${result.totalMatches} candidates for ${result.query}`);
  for (const source of result.sources) console.log(`Index: ${source.state} · ${source.sourceRef}`);
  for (const item of result.candidates) console.log(`\n${item.qualifiedId} · ${item.type}/${item.runtime} · relevance ${item.relevanceScore}\n${item.description || "No cached description; inspect source before selection."}\nSource: ${item.sourceRef}\nMatched: ${item.matchedTerms.join(", ")} (${item.matchedFields.join(", ")})\nQualification: ${item.qualification}; invocation: ${item.invocationState}; route eligibility in cache: ${item.routeEligible}; ambiguous: ${item.collision.ambiguous}; execution blocked: ${item.executionBlock}`);
  if (result.gap) console.log(`\nGap: ${result.gap.reason}`);
  if (result.sources.some((source) => source.state !== "fresh")) console.log(`Refresh explicitly: ${result.refreshCommand}`);
  console.log(`\n${result.boundary}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Capability search refused: ${error.message}`); process.exitCode = 2; });
}
