/**
 * @typedef {object} LiveTokenUsage
 * @property {number|null} inputTokens Observed input count, including a measured zero.
 * @property {number|null} outputTokens Observed output count, including a measured zero.
 * @property {number|null} totalTokens Explicitly observed total; never inferred from other fields.
 */

/** Preserve observed integer counts without coercing unknown values into measurements. */
function normalizeLiveTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? (value === 0 ? 0 : value) : null;
}

/** The first nonempty field is authoritative, even if its value is invalid. */
function readLiveTokenCount(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") return normalizeLiveTokenCount(value);
  }
  return null;
}

/**
 * Normalize one node's observed usage without computing or accumulating totals.
 * Legacy scalar `tokens` and `tokenCount` fields mean output tokens in the Live
 * page. Object containers, numeric strings and observation wrappers are not counts.
 *
 * @param {unknown} record Current node snapshot.
 * @returns {LiveTokenUsage}
 */
export function normalizeLiveTokenUsage(record) {
  const source = record && typeof record === "object" && !Array.isArray(record) ? record : {};
  return {
    inputTokens: readLiveTokenCount(source, ["inputTokens"]),
    outputTokens: readLiveTokenCount(source, ["outputTokens", "tokens", "tokenCount"]),
    totalTokens: readLiveTokenCount(source, ["totalTokens"]),
  };
}

/**
 * Count measurement coverage for caller-scoped execution nodes in one snapshot.
 * `measuredNodeCount` means at least one usage field is known; output-only UI
 * must use `outputMeasuredNodeCount`. No field contains a sum of token counts.
 *
 * @param {unknown} nodes Execution nodes already scoped by the caller.
 * @returns {{nodeCount: number, measuredNodeCount: number, unknownNodeCount: number,
 *   inputMeasuredNodeCount: number, outputMeasuredNodeCount: number, totalMeasuredNodeCount: number}}
 */
export function summarizeLiveTokenCoverage(nodes) {
  const records = Array.isArray(nodes) ? nodes : [];
  const coverage = {
    nodeCount: records.length,
    measuredNodeCount: 0,
    unknownNodeCount: 0,
    inputMeasuredNodeCount: 0,
    outputMeasuredNodeCount: 0,
    totalMeasuredNodeCount: 0,
  };
  for (const record of records) {
    const usage = normalizeLiveTokenUsage(record);
    const inputMeasured = usage.inputTokens !== null;
    const outputMeasured = usage.outputTokens !== null;
    const totalMeasured = usage.totalTokens !== null;
    if (inputMeasured) coverage.inputMeasuredNodeCount += 1;
    if (outputMeasured) coverage.outputMeasuredNodeCount += 1;
    if (totalMeasured) coverage.totalMeasuredNodeCount += 1;
    if (inputMeasured || outputMeasured || totalMeasured) coverage.measuredNodeCount += 1;
    else coverage.unknownNodeCount += 1;
  }
  return coverage;
}

/**
 * Format an explicit count; unknown usage is never rendered as numeric zero.
 *
 * @param {unknown} value Observed token count.
 * @param {string} [language="zh"] Live page language.
 * @returns {string}
 */
export function formatLiveTokenCount(value, language = "zh") {
  const count = normalizeLiveTokenCount(value);
  if (count === null) return language === "zh" ? "未计量" : "Not measured";
  return count.toLocaleString(language === "zh" ? "zh-CN" : "en-US");
}

/** Ship every dependency with the tested helpers into the dependency-free client. */
export function serializeLiveTokenUsageResolvers() {
  return [normalizeLiveTokenCount, readLiveTokenCount, normalizeLiveTokenUsage,
    summarizeLiveTokenCoverage, formatLiveTokenCount]
    .map((resolver) => resolver.toString()).join("\n");
}
