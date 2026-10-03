#!/usr/bin/env node

import process from "node:process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_LEXICON_PATH = path.resolve(
  SCRIPT_DIR,
  "../config/governance/entry-classification-lexicon.json",
);
const ENTRY_LEXICON = JSON.parse(readFileSync(ENTRY_LEXICON_PATH, "utf8"));

const REQUIRED_LEXICON_CATEGORIES = Object.freeze([
  "action",
  "durableOutput",
  "subjectiveQuality",
  "fileOrMutationObject",
  "productBuildObject",
  "projectUnderstanding",
]);
const REQUIRED_LEXICON_LANGUAGES = Object.freeze(["en", "zh", "ja", "ko"]);
const MAX_TERMS_PER_LANGUAGE = 128;
const MAX_TERM_LENGTH = 80;

export function validateEntryLexicon(lexicon) {
  if (lexicon?.schemaVersion !== 1 || !lexicon.categories || typeof lexicon.categories !== "object") {
    throw new Error(`Unsupported entry classification lexicon: ${ENTRY_LEXICON_PATH}`);
  }
  const categoryNames = Object.keys(lexicon.categories).sort();
  if (categoryNames.join("|") !== [...REQUIRED_LEXICON_CATEGORIES].sort().join("|")) {
    throw new Error(`Entry lexicon must define exactly: ${REQUIRED_LEXICON_CATEGORIES.join(", ")}`);
  }
  for (const categoryName of REQUIRED_LEXICON_CATEGORIES) {
    const category = lexicon.categories[categoryName];
    const languageNames = Object.keys(category ?? {}).sort();
    if (languageNames.join("|") !== [...REQUIRED_LEXICON_LANGUAGES].sort().join("|")) {
      throw new Error(`${categoryName} must define exactly en, zh, ja, and ko string arrays`);
    }
    for (const language of REQUIRED_LEXICON_LANGUAGES) {
      const terms = category[language];
      if (!Array.isArray(terms) || terms.length === 0 || terms.length > MAX_TERMS_PER_LANGUAGE) {
        throw new Error(`${categoryName}.${language} must contain 1-${MAX_TERMS_PER_LANGUAGE} terms`);
      }
      const normalized = terms.map((term) => {
        if (
          typeof term !== "string" ||
          !term.trim() ||
          term !== term.trim() ||
          term.length > MAX_TERM_LENGTH
        ) {
          throw new Error(`${categoryName}.${language} contains an invalid term`);
        }
        return term.trim();
      });
      if (new Set(normalized).size !== normalized.length) {
        throw new Error(`${categoryName}.${language} contains duplicate terms`);
      }
    }
  }
  return lexicon;
}

validateEntryLexicon(ENTRY_LEXICON);

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createLexiconMatcher(categoryName) {
  const category = ENTRY_LEXICON.categories[categoryName];
  if (!category) throw new Error(`Missing entry lexicon category: ${categoryName}`);
  const english = category.en.map(escapeRegex).join("|");
  const substringTerms = ["zh", "ja", "ko"]
    .flatMap((language) => category[language])
    .map(escapeRegex)
    .join("|");
  const alternatives = [];
  if (english) alternatives.push(`(?:^|[^A-Za-z0-9_])(?:${english})(?=$|[^A-Za-z0-9_])`);
  if (substringTerms) alternatives.push(`(?:${substringTerms})`);
  if (alternatives.length === 0) throw new Error(`Empty entry lexicon matcher: ${categoryName}`);
  return new RegExp(alternatives.join("|"), "iu");
}

const EXPLICIT_META_THEORY_RE =
  /(?:^|\b)(?:\/?meta-theory|meta theory|run meta theory|execute meta theory)(?:\b|$)|元理论/u;

const ACTION_RE = createLexiconMatcher("action");

const DURABLE_OUTPUT_RE = createLexiconMatcher("durableOutput");

const PURE_QUERY_RE =
  /^(?:what|why|how|when|where|who|is|are|can|could|should)\b|^(?:什么|为什么|怎么|如何|是否|能否|可以|介绍|解释|说明)/iu;
const DEFINITION_QUERY_RE = /^what\s+(?:does|do)\s+(?:it\s+mean\s+to\s+[^,.?!;\r\n]+|[^,.?!;\r\n]+\s+mean)[.?]?\s*$/iu;
function isDefinitionQuery(text) {
  return DEFINITION_QUERY_RE.test(text)
    && !/\b(?:and|then)\s+(?:please\b|(?:can|could|would)\s+you\b)/iu.test(text);
}

const CHINESE_QUERY_WORD_RE = /(?:什么|为什么|怎么|如何|是否|能否|可以吗|吗|介绍|解释|说明)/u;

const SUBJECTIVE_QUALITY_RE = createLexiconMatcher("subjectiveQuality");

const FILE_OR_MUTATION_RE = createLexiconMatcher("fileOrMutationObject");

const PRODUCT_BUILD_OBJECT_RE = createLexiconMatcher("productBuildObject");

const PROJECT_UNDERSTANDING_RE = createLexiconMatcher("projectUnderstanding");

const PARALLEL_AGENT_RE =
  /\b(?:parallel|subagents?|agent team|multi-agent|fan[- ]?out|delegate|spawn|review\s*\+\s*fix\s*\+\s*verify)\b|(?:并行|子智能体|子agent|多个\s*agent|多智能体|编排|分工|派发|噼里啪啦)/iu;

const STRUCTURED_GOVERNANCE_CHAIN_RE =
  /critical(?:\s+thinking)?(?:\s*(?:->|=>|→|,|，|、|;|；|and)?\s+)fetch(?:\s*(?:->|=>|→|,|，|、|;|；|and)?\s+)(?:deep\s+)?thinking(?:\s*(?:->|=>|→|,|，|、|;|；|and)?\s+)review|critical\s+and\s+fetch\s+thinking\s+and\s+review/iu;

const COMPLEXITY_COMPLAINT_RE =
  /\b(?:too slow|slow|serial|not using agents?|missing agents?|no agents?|keeps?\s+creating|always\s+creates?)\b|(?:太慢|慢|不用\s*agent|没用\s*agent|没有\s*agent|没看到.*agent|串行|不会判断.*复杂|做的.*差|(?:codex|meta[_ -]?kim|metakim|系统|它|他).{0,16}(?:一直|反复|不断|重复|老是|总是|好像).{0,16}(?:自己)?(?:创建|新建)|(?:一直|反复|不断|重复|老是|总是).{0,16}(?:自己)?(?:创建|新建))/iu;

const MULTI_LANE_WORD_RE =
  /\b(?:review|fix|verify|test|release|sync|hook|security|frontend|backend|database|api|docs|research|runtime|mcp|tool|agent|skill)\b|(?:审查|修复|验证|测试|发布|同步|钩子|安全|前端|后端|数据库|接口|文档|调研|运行时|工具|智能体|技能)/giu;

const HIGH_RISK_DECISION_RE =
  /\b(?:deploy|publish|release|production|auth|permission|security|delete|remove|payment|credential|secret|database|migration)\b|(?:发布(?!器|助手|工具|平台|系统)|上线|生产|权限|安全|删除|支付|凭证|密钥|数据库|迁移)/iu;

const DESTRUCTIVE_OR_PRODUCTION_RE =
  /\b(?:delete|remove|drop|truncate|wipe|purge)\b|\b(?:deploy|publish|release)\b(?=.{0,40}\b(?:production|prod|live)\b)|\bproduction\b(?=.{0,40}\b(?:database|deploy|release|environment)\b)|(?:删除|清空|销毁|移除).{0,24}(?:生产|数据库|数据|文件|资源)|(?:发布|部署).{0,16}(?:上线|生产环境)|(?:发布上线|部署上线|上线生产|生产环境)/iu;

function normalizePrompt(prompt) {
  return String(prompt ?? "").trim();
}

function hasQuestionOnlyShape(text) {
  if (!PURE_QUERY_RE.test(text) && !CHINESE_QUERY_WORD_RE.test(text)) return false;
  // A verb named inside a complete definition question is its subject, not an
  // instruction to execute. A following sentence or clause still routes work.
  if (isDefinitionQuery(text)) return true;
  if (ACTION_RE.test(text) && DURABLE_OUTPUT_RE.test(text)) return false;
  if (FILE_OR_MUTATION_RE.test(text) && ACTION_RE.test(text)) return false;
  return true;
}

function countDistinctMatches(text, regex) {
  return new Set([...String(text ?? "").matchAll(regex)].map((match) => match[0].toLowerCase())).size;
}

function buildEntrySignals(text, context) {
  const lineCount = normalizePrompt(text).split(/\n+/u).filter(Boolean).length;
  const delimitedSegmentCount = normalizePrompt(text)
    .split(/[，,、；;]+/u)
    .filter((item) => item.trim()).length;
  const routeChangingDimensionSignals = [];
  if (context.subjectiveQuality) routeChangingDimensionSignals.push("quality_or_acceptance");
  if (context.fileOrMutationIntent || context.productBuildIntent) {
    routeChangingDimensionSignals.push("scope");
  }
  if (HIGH_RISK_DECISION_RE.test(text)) routeChangingDimensionSignals.push("risk_or_permission");

  return {
    explicitMetaTheory: context.explicitMetaTheory,
    governedMetaTrigger: context.governedMetaTrigger,
    actionIntent: context.actionIntent,
    durableOutputIntent: context.durableOutputIntent,
    fileOrMutationIntent: context.fileOrMutationIntent,
    productBuildIntent: context.productBuildIntent,
    projectUnderstandingIntent: context.projectUnderstandingIntent,
    pureQueryShape: context.pureQuery,
    subjectiveQualitySignal: context.subjectiveQuality,
    highRiskTermSignal: HIGH_RISK_DECISION_RE.test(text),
    destructiveOrProductionTermSignal: DESTRUCTIVE_OR_PRODUCTION_RE.test(text),
    destructiveOrProductionIntent: context.destructiveOrProductionIntent === true,
    queryPreambleSignal: PURE_QUERY_RE.test(text) || CHINESE_QUERY_WORD_RE.test(text),
    directParallelRequest: context.directParallelAgentRequest,
    structuredGovernanceChainRequest: context.structuredGovernanceChainRequest,
    serialOrSlowRouteComplaint: context.serialAgentRouteComplaint,
    routeChangingDimensionSignals,
    parallelismHints: {
      lineCount,
      delimitedSegmentCount,
      distinctCapabilityTermCount: countDistinctMatches(text, MULTI_LANE_WORD_RE),
      reviewFixVerifyPattern: /review\s*\+\s*fix\s*\+\s*verify|审查.*修复.*验证|修复.*测试.*发布/iu.test(text),
    },
  };
}

function withEntrySignals(base, text, context) {
  return {
    ...base,
    signals: buildEntrySignals(text, context),
  };
}

export function classifyMetaTheoryEntry(prompt) {
  const text = normalizePrompt(prompt);
  const lower = text.toLowerCase();
  const explicitMetaTheory = EXPLICIT_META_THEORY_RE.test(text);
  const subjectiveQuality = SUBJECTIVE_QUALITY_RE.test(text);
  const actionIntent = ACTION_RE.test(text) && !isDefinitionQuery(text);
  const durableOutputIntent = DURABLE_OUTPUT_RE.test(text);
  const fileOrMutationIntent = FILE_OR_MUTATION_RE.test(text);
  const productBuildIntent = actionIntent && PRODUCT_BUILD_OBJECT_RE.test(text);
  const projectUnderstandingIntent = PROJECT_UNDERSTANDING_RE.test(text);
  const pureQuery = hasQuestionOnlyShape(text);
  const directParallelAgentRequest = PARALLEL_AGENT_RE.test(text);
  const structuredGovernanceChainRequest = STRUCTURED_GOVERNANCE_CHAIN_RE.test(text);
  const serialAgentRouteComplaint = COMPLEXITY_COMPLAINT_RE.test(text);
  const destructiveOrProductionIntent =
    DESTRUCTIVE_OR_PRODUCTION_RE.test(text) &&
    !(PURE_QUERY_RE.test(text) || CHINESE_QUERY_WORD_RE.test(text));
  const governedMetaTrigger =
    explicitMetaTheory ||
    structuredGovernanceChainRequest ||
    directParallelAgentRequest ||
    serialAgentRouteComplaint ||
    destructiveOrProductionIntent ||
    (subjectiveQuality && actionIntent) ||
    (actionIntent && (durableOutputIntent || fileOrMutationIntent || productBuildIntent)) ||
    projectUnderstandingIntent;
  const fanoutContext = {
    explicitMetaTheory,
    governedMetaTrigger,
    productBuildIntent,
    durableOutputIntent,
    fileOrMutationIntent,
    subjectiveQuality,
    actionIntent,
    projectUnderstandingIntent,
    pureQuery,
    directParallelAgentRequest,
    structuredGovernanceChainRequest,
    serialAgentRouteComplaint,
    destructiveOrProductionIntent,
  };

  if (!text) {
    return withEntrySignals({
      governedEntry: false,
      path: "fast_path",
      taskClassification: "empty_input",
      triggerReason: "empty_input",
      confidence: 1,
    }, text, fanoutContext);
  }

  if (explicitMetaTheory) {
    return withEntrySignals({
      governedEntry: true,
      path: "regulated_path",
      taskClassification: "meta_theory_explicit",
      triggerReason: "explicit_meta_theory",
      confidence: 1,
    }, text, fanoutContext);
  }

  if (directParallelAgentRequest || serialAgentRouteComplaint) {
    return withEntrySignals({
      governedEntry: true,
      path: "standard_path",
      taskClassification: "meta_theory_auto",
      triggerReason: directParallelAgentRequest
        ? "direct_parallel_dispatch_request"
        : "serial_agent_route_complaint",
      confidence: directParallelAgentRequest ? 0.9 : 0.82,
    }, text, fanoutContext);
  }

  if (destructiveOrProductionIntent) {
    return withEntrySignals({
      governedEntry: true,
      path: "standard_path",
      taskClassification: "meta_theory_auto",
      triggerReason: "high_risk_execution_intent",
      confidence: 0.94,
    }, text, fanoutContext);
  }

  if (subjectiveQuality && actionIntent) {
    return withEntrySignals({
      governedEntry: true,
      path: "standard_path",
      taskClassification: "meta_theory_auto",
      triggerReason: "subjective_quality_ambiguous",
      confidence: 0.9,
    }, text, fanoutContext);
  }

  if (structuredGovernanceChainRequest) {
    return withEntrySignals({
      governedEntry: true,
      path: "standard_path",
      taskClassification: "meta_theory_auto",
      triggerReason: "critical_fetch_thinking_review_requested",
      confidence: 0.9,
    }, text, fanoutContext);
  }

  if (actionIntent && (durableOutputIntent || fileOrMutationIntent || productBuildIntent)) {
    return withEntrySignals({
      governedEntry: true,
      path: "standard_path",
      taskClassification: "meta_theory_auto",
      triggerReason: productBuildIntent
          ? "natural_language_product_build"
          : durableOutputIntent
        ? "natural_language_durable_work"
          : "natural_language_execution_work",
      confidence: productBuildIntent && !durableOutputIntent ? 0.82 : 0.86,
    }, text, fanoutContext);
  }

  if (projectUnderstandingIntent) {
    return withEntrySignals({
      governedEntry: true,
      path: "standard_path",
      taskClassification: "meta_theory_auto",
      triggerReason: "project_understanding_requires_fetch",
      confidence: 0.84,
    }, text, fanoutContext);
  }

  if (pureQuery) {
    return withEntrySignals({
      governedEntry: false,
      path: "fast_path",
      taskClassification: "pure_query",
      triggerReason: "pure_query",
      confidence: 0.84,
    }, text, fanoutContext);
  }

  if (lower.includes("?") || text.includes("？")) {
    return withEntrySignals({
      governedEntry: false,
      path: "fast_path",
      taskClassification: "read_only_question",
      triggerReason: "read_only_question",
      confidence: 0.7,
    }, text, fanoutContext);
  }

  return withEntrySignals({
    governedEntry: false,
    path: "fast_path",
    taskClassification: "unclassified_low_signal",
    triggerReason: "no_governance_trigger",
    confidence: 0.55,
  }, text, fanoutContext);
}

function main() {
  const prompt = process.argv.slice(2).join(" ");
  process.stdout.write(`${JSON.stringify(classifyMetaTheoryEntry(prompt), null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
