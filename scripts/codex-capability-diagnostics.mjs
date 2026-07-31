#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_SKILL_METADATA_CHAR_BUDGET = 8000;
export const SKILL_METADATA_CONTEXT_WINDOW_PERCENT = 2;
export const APPROX_BYTES_PER_TOKEN = 4;

function argValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
    else if (process.argv[index].startsWith(`${name}=`)) values.push(process.argv[index].slice(name.length + 1));
  }
  return values;
}

function descriptionFor(entry) {
  return String(entry?.metadata?.description ?? entry?.description ?? "");
}

function estimatedTokens(value) {
  return Math.ceil(Buffer.byteLength(String(value ?? ""), "utf8") / APPROX_BYTES_PER_TOKEN);
}

function codexSkills(inventory, view) {
  if (view === "raw") {
    return Object.values(inventory?.byPlatform ?? {})
      .filter((platform) => ["codex", "codexapp"].includes(String(platform?.platformId).toLowerCase()))
      .flatMap((platform) => platform?.capabilities?.skills ?? []);
  }
  return Object.values(inventory?.byCapabilityType?.skills ?? {})
    .filter((entry) => ["codex", "codexapp"].includes(String(entry?.platformId).toLowerCase()));
}

function sourceSummary(entries, winners) {
  const classes = ["project", "personal", "shared", "legacy", "plugin"];
  return Object.fromEntries(classes.map((sourceClass) => {
    const raw = entries.filter((entry) => entry.sourceClass === sourceClass);
    const selected = winners.filter((entry) => entry.sourceClass === sourceClass);
    const descriptionChars = raw.reduce((sum, entry) => sum + descriptionFor(entry).length, 0);
    const winnerDescriptionChars = selected.reduce(
      (sum, entry) => sum + descriptionFor(entry).length,
      0,
    );
    return [sourceClass, {
      raw: raw.length,
      winner: selected.length,
      exactDuplicate: selected.filter((entry) => entry.collision?.kind === "exact_duplicate").length,
      descriptionChars,
      estimatedTokens: raw.reduce((sum, entry) => sum + estimatedTokens(descriptionFor(entry)), 0),
      winnerDescriptionChars,
      winnerEstimatedTokens: selected.reduce(
        (sum, entry) => sum + estimatedTokens(descriptionFor(entry)),
        0,
      ),
    }];
  }));
}

/**
 * Compute a conservative projection from the source-aware inventory. This does
 * not reproduce Codex renderer path, alias, line, shortening, or ordering logic.
 */
export function computeSkillMetadataPreflight(
  inventory,
  { contextWindow = null, hostArtifacts = [] } = {},
) {
  const raw = codexSkills(inventory, "raw");
  const winners = codexSkills(inventory, "winner");
  const hasWindow = Number.isFinite(Number(contextWindow)) && Number(contextWindow) > 0;
  const budget = hasWindow
    ? {
        unit: "tokens",
        value: Math.max(
          1,
          Math.floor(Number(contextWindow) * SKILL_METADATA_CONTEXT_WINDOW_PERCENT / 100),
        ),
        source: "context_window_percent",
      }
    : {
        unit: "characters",
        value: DEFAULT_SKILL_METADATA_CHAR_BUDGET,
        source: "fallback_character_budget",
      };
  const projected = {
    evidenceClass: "projected_inventory",
    fidelity: "projected_estimate",
    limitation:
      "Does not reproduce Codex absolute/aliased line rendering, description shortening, or final ordering/omission behavior.",
    rawCount: raw.length,
    winnerCount: winners.length,
    shadowedSourceCount: Math.max(0, raw.length - winners.length),
    exactDuplicateCount: winners.filter((entry) => entry.collision?.kind === "exact_duplicate").length,
    assessedView: "raw_host_visible_candidate_set",
    descriptionChars: raw.reduce((sum, entry) => sum + descriptionFor(entry).length, 0),
    estimatedTokens: raw.reduce((sum, entry) => sum + estimatedTokens(descriptionFor(entry)), 0),
    logicalWinnerDescriptionChars: winners.reduce(
      (sum, entry) => sum + descriptionFor(entry).length,
      0,
    ),
    logicalWinnerEstimatedTokens: winners.reduce(
      (sum, entry) => sum + estimatedTokens(descriptionFor(entry)),
      0,
    ),
    bySourceClass: sourceSummary(raw, winners),
  };
  const projectedUsage = budget.unit === "tokens"
    ? projected.estimatedTokens
    : projected.descriptionChars;
  const reportedHostArtifacts = hostArtifacts.map((artifact) => ({
    evidenceClass: "reported_host_artifact",
    verificationStatus: "unverified",
    total: artifact?.total ?? null,
    included: artifact?.included ?? null,
    omitted: artifact?.omitted ?? artifact?.omitted_count ?? null,
    truncatedDescriptionChars:
      artifact?.truncated_description_chars ?? artifact?.truncatedDescriptionChars ?? null,
    truncatedDescriptionCount:
      artifact?.truncated_description_count ?? artifact?.truncatedDescriptionCount ?? null,
    sourceRef: artifact?.sourceRef ?? null,
  }));
  const reportedArtifactPresent = reportedHostArtifacts.length > 0;
  const reportedArtifactRisk = reportedHostArtifacts.some((entry) =>
    Number(entry.omitted ?? 0) > 0 ||
    Number(entry.truncatedDescriptionChars ?? 0) > 0 ||
    Number(entry.truncatedDescriptionCount ?? 0) > 0
  );
  const projectedOverBudget = projectedUsage > budget.value;
  const logicalWinnerUsage = budget.unit === "tokens"
    ? projected.logicalWinnerEstimatedTokens
    : projected.logicalWinnerDescriptionChars;
  const logicalWinnerProjectedOverBudget = logicalWinnerUsage > budget.value;
  return {
    schemaVersion: "codex-capability-diagnostics-v0.1",
    kind: "skill_metadata_preflight",
    budget,
    projected,
    reportedHostArtifacts,
    hostObserved: [],
    conclusion: {
      status: projectedOverBudget || reportedArtifactRisk ? "risk" : "partial",
      hostObservationRequired: true,
      hostObservationVerificationRequired: reportedArtifactPresent,
      verifiedHostObservationPresent: false,
      projectedOverBudget,
      logicalWinnerProjectedOverBudget,
      reason: reportedArtifactPresent
        ? "host_observation_verification_required"
        : "host_observation_required",
    },
  };
}

function eventType(event) {
  const outerType = String(event?.type ?? "").toLowerCase();
  if (["event_msg", "response_item"].includes(outerType) && event?.payload?.type) {
    return String(event.payload.type).toLowerCase();
  }
  return String(event?.type ?? event?.method ?? event?.event?.type ?? "").toLowerCase();
}

function eventMessage(event) {
  return [
    event?.message,
    event?.error?.message,
    event?.item?.message,
    event?.item?.error?.message,
    event?.payload?.message,
    event?.payload?.error?.message,
    event?.payload?.item?.message,
    event?.payload?.item?.error?.message,
    typeof event?.payload?.content === "string" ? event.payload.content : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function numericValues(value, keyPattern, output = []) {
  if (!value || typeof value !== "object") return output;
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "number" && keyPattern.test(key)) output.push(nested);
    else if (nested && typeof nested === "object") numericValues(nested, keyPattern, output);
  }
  return output;
}

/** Replay existing Codex exec/app-server JSONL without invoking a model. */
export async function replayCodexJsonl(files) {
  const reports = [];
  for (const file of files) {
    const rawJsonl = await fs.readFile(file, "utf8");
    const lines = rawJsonl.split(/\r?\n/u);
    const events = [];
    const malformedLines = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) continue;
      try {
        events.push(JSON.parse(lines[index]));
      } catch {
        malformedLines.push(index + 1);
      }
    }
    let droppedEventCount = 0;
    let skillBudgetWarningCount = 0;
    const omittedSkillCounts = [];
    const messageReportedOmittedSkillCounts = [];
    const truncatedSkillCounts = [];
    const averageDescriptionCharsPerSkillValues = [];
    let descriptionShorteningReported = false;
    let turnCompleted = false;
    let turnFailed = false;
    let exitReceiptObserved = false;
    let exitSuccess = false;
    let fatalErrorCount = 0;
    let itemErrorCount = 0;
    let capabilityDefinitionWarningCount = 0;
    let deprecationWarningCount = 0;
    let otherItemErrorCount = 0;
    let lagWarningCount = 0;
    const tokens = { input: 0, cachedInput: 0, output: 0 };
    for (const event of events) {
      const type = eventType(event);
      const message = eventMessage(event);
      const lagSignal = /(?:lag|lagged|dropped|behind).*event|event.*(?:lag|dropped|behind)/iu.test(message);
      const skillBudgetSignal =
        /skill.*(?:metadata|budget|description|omitt|truncat)|(?:metadata|budget|description|omitt|truncat).*skill/iu.test(
          `${type} ${message}`,
        );
      const droppedMatch = message.match(/dropped\s+(\d+)\s+events?/iu);
      if (droppedMatch) droppedEventCount += Number(droppedMatch[1]);
      droppedEventCount += numericValues(event, /^(?:dropped_count|droppedCount)$/u)
        .reduce((sum, value) => sum + value, 0);
      if (skillBudgetSignal) {
        skillBudgetWarningCount += 1;
        omittedSkillCounts.push(
          ...numericValues(event, /^(?:omitted|omitted_count|omittedSkillCount)$/u),
        );
        truncatedSkillCounts.push(
          ...numericValues(event, /^(?:truncated|truncated_count|truncatedDescriptionCount)$/u),
        );
      }
      const omittedMessageMatch = message.match(
        /All skill descriptions were removed and\s+(\d+)\s+additional skills were not included/iu,
      ) ?? message.match(/(\d+)\s+(?:additional\s+)?skills?\s+(?:were\s+)?not included/iu);
      if (omittedMessageMatch) {
        messageReportedOmittedSkillCounts.push(Number(omittedMessageMatch[1]));
        skillBudgetWarningCount = Math.max(skillBudgetWarningCount, 1);
      }
      const averageCharsMatch = message.match(
        /average of\s+(\d+)\s+characters?\s+per skill/iu,
      );
      if (averageCharsMatch) {
        averageDescriptionCharsPerSkillValues.push(Number(averageCharsMatch[1]));
        skillBudgetWarningCount = Math.max(skillBudgetWarningCount, 1);
      }
      if (/All skill descriptions were removed|\b(?:shorten(?:ed|ing)?|truncat(?:ed|ion|ing)?)\b/iu.test(message)) {
        descriptionShorteningReported = true;
      }
      if (["turn.completed", "turn/completed"].includes(type)) turnCompleted = true;
      if (["turn.failed", "turn/failed"].includes(type)) turnFailed = true;
      if (/process.*completed/u.test(type)) {
        exitReceiptObserved = true;
        const exitCodes = numericValues(event, /^(?:exit_code|exitCode)$/u);
        exitSuccess = exitCodes.length > 0 && Number(exitCodes.at(-1)) === 0;
      }
      const topLevelError =
        type === "error" || type === "turn.failed" || Boolean(event?.error ?? event?.payload?.error);
      const itemError = event?.item?.type === "error" || event?.payload?.item?.type === "error";
      if (lagSignal && (topLevelError || itemError)) lagWarningCount += 1;
      else {
        if (topLevelError) fatalErrorCount += 1;
        if (itemError) {
          itemErrorCount += 1;
          if (/malformed agent role definition|duplicate agent role name/iu.test(message)) {
            capabilityDefinitionWarningCount += 1;
          } else if (/\bdeprecated\b/iu.test(message)) {
            deprecationWarningCount += 1;
          } else if (!skillBudgetSignal) {
            otherItemErrorCount += 1;
          }
        }
      }
      tokens.input = Math.max(tokens.input, ...numericValues(event, /^(?:input_tokens|inputTokens)$/u));
      tokens.cachedInput = Math.max(tokens.cachedInput, ...numericValues(event, /^(?:cached_input_tokens|cachedInputTokens)$/u));
      tokens.output = Math.max(tokens.output, ...numericValues(event, /^(?:output_tokens|outputTokens)$/u));
    }
    const lagDisposition = lagWarningCount === 0
      ? "none"
      : turnCompleted && exitReceiptObserved && exitSuccess && !turnFailed && fatalErrorCount === 0
        ? "nonfatal_warning_when_turn_completed"
        : "unresolved_without_successful_exit_receipt";
    const omittedSkillCount = omittedSkillCounts.length > 0
      ? Math.max(...omittedSkillCounts)
      : messageReportedOmittedSkillCounts.length > 0
        ? Math.max(...messageReportedOmittedSkillCounts)
        : null;
    const omittedCountEvidence = omittedSkillCounts.length > 0
      ? "numeric_field"
      : messageReportedOmittedSkillCounts.length > 0
        ? "message_reported"
        : "unknown";
    const truncatedSkillCount = truncatedSkillCounts.length > 0
      ? Math.max(...truncatedSkillCounts)
      : null;
    const averageDescriptionCharsPerSkill = averageDescriptionCharsPerSkillValues.length > 0
      ? Math.max(...averageDescriptionCharsPerSkillValues)
      : null;
    const processExitFailure = exitReceiptObserved && !exitSuccess;
    reports.push({
      sourceRef: path.basename(file),
      sourceDigest: createHash("sha256").update(rawJsonl).digest("hex"),
      sourceBinding: {
        scope: "whole_file",
        runTurnBound: false,
        evidenceClass: "observed_markers_only",
      },
      parsedEventCount: events.length,
      malformedLineCount: malformedLines.length,
      malformedLines,
      eventStream: { droppedEventCount, lagWarningCount, lagDisposition },
      runtimeDiagnostics: {
        itemErrorCount,
        capabilityDefinitionWarningCount,
        deprecationWarningCount,
        otherItemErrorCount,
        itemErrorsAreNotProcessFatalWithoutTurnFailure: true,
      },
      skillBudget: {
        warningCount: skillBudgetWarningCount,
        omittedSkillCount,
        omittedCountEvidence,
        truncatedSkillCount,
        truncatedCountEvidence: truncatedSkillCounts.length > 0 ? "numeric_field" : "unknown",
        averageDescriptionCharsPerSkill,
        averageDescriptionCharsEvidence:
          averageDescriptionCharsPerSkillValues.length > 0 ? "message_reported" : "unknown",
        descriptionShorteningReported,
      },
      turn: {
        completed: turnCompleted,
        failed: turnFailed,
        exitReceipt: { observed: exitReceiptObserved, success: exitReceiptObserved && exitSuccess },
      },
      tokens: {
        aggregation: "max_observed_high_water_not_session_sum",
        ...tokens,
      },
      conclusion: {
        status: turnFailed || processExitFailure || fatalErrorCount > 0 || malformedLines.length > 0
          ? "observed_fatal_or_invalid_markers"
          : turnCompleted && exitReceiptObserved && exitSuccess
            ? "observed_turn_and_exit_markers_unbound"
            : turnCompleted
              ? "observed_turn_completed_marker_without_exit_binding"
              : "partial_observed_markers",
        fatalErrorCount,
        processExitFailure,
        causalInference: "not_inferred_between_skill_budget_and_event_stream",
        diagnosticOnly: true,
        publicReady: false,
      },
    });
  }
  return { schemaVersion: "codex-capability-diagnostics-v0.1", kind: "jsonl_replay", reports };
}

async function main() {
  const mode = argValues("--mode")[0] ?? "preflight";
  if (mode === "replay") {
    const files = [...argValues("--jsonl"), ...argValues("--file")];
    if (files.length === 0) throw new Error("replay requires at least one --jsonl <path>");
    console.log(JSON.stringify(await replayCodexJsonl(files), null, 2));
    return;
  }
  const inventoryPath = argValues("--inventory")[0];
  if (!inventoryPath) throw new Error("preflight requires --inventory <global-capabilities.json>");
  const inventory = JSON.parse(await fs.readFile(inventoryPath, "utf8"));
  const hostArtifacts = [];
  for (const artifactPath of argValues("--host-artifact")) {
    hostArtifacts.push({
      ...JSON.parse(await fs.readFile(artifactPath, "utf8")),
      sourceRef: path.basename(artifactPath),
    });
  }
  const contextWindow = argValues("--context-window")[0];
  console.log(JSON.stringify(computeSkillMetadataPreflight(inventory, {
    contextWindow: contextWindow ? Number(contextWindow) : null,
    hostArtifacts,
  }), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
