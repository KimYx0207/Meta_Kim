/**
 * Display-format policy for the Meta_Kim Live control room.
 *
 * The control room renders observed run data. Two formatting decisions were
 * previously hardcoded in the page and both produced misleading output:
 *
 *   1. An em dash was substituted for *any* missing value, including values the
 *      caller explicitly wanted rendered as nothing. Structural spans then
 *      carried stray dashes, and downstream guards had to filter the string
 *      "—" back out to tell a real value from a placeholder.
 *   2. Run identifiers were truncated with a fixed tail slice, so
 *      `live-ui-regression` displayed as `GRESSION` — a string that appears
 *      nowhere in the run and cannot be matched back to it.
 *
 * The placeholder glyph, the identifier short form, and the node-task dedupe
 * policy therefore live in `config/live/display-format.json` rather than in the
 * renderer.
 *
 * `shortenIdentifier` and `resolveNodeTaskLine` are serialized into the shipped
 * client bundle, so each must reference nothing outside its own body except JS
 * built-ins and its own parameters.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LIVE_DISPLAY_FORMAT_SCHEMA_VERSION = "meta-kim-live-display-format-v1";

export const LIVE_DISPLAY_FORMAT_CONFIG_URL = new URL(
  "../../../config/live/display-format.json",
  import.meta.url,
);

function fail(message, code = "LIVE_DISPLAY_FORMAT_INVALID") {
  const error = new TypeError(`Live display format: ${message}`);
  error.code = code;
  throw error;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) fail(`${label} must be a positive integer`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value === "") fail(`${label} must be a non-empty string`);
  return value;
}

function stringList(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return Object.freeze(value.map((entry, index) => requiredString(entry, `${label}[${index}]`)));
}

/**
 * The non-informative list is matched against case-folded observed values, so a
 * mixed-case entry could never match anything. Reject it instead of silently
 * lower-casing it, which would make the shipped document disagree with what the
 * renderer actually compares against.
 */
function foldedStringList(value, label) {
  const entries = stringList(value, label);
  entries.forEach((entry, index) => {
    if (entry !== entry.toLowerCase()) {
      fail(`${label}[${index}] must be lower case; it is compared against case-folded values`);
    }
  });
  return entries;
}

function normalizeIdentifierShortForm(raw) {
  if (!raw || typeof raw !== "object") fail("identifierShortForm must be an object");
  const shortForm = {
    maxChars: positiveInteger(raw.maxChars, "identifierShortForm.maxChars"),
    headChars: positiveInteger(raw.headChars, "identifierShortForm.headChars"),
    tailChars: positiveInteger(raw.tailChars, "identifierShortForm.tailChars"),
    ellipsis: requiredString(raw.ellipsis, "identifierShortForm.ellipsis"),
  };
  const shortened = shortForm.headChars + shortForm.tailChars + shortForm.ellipsis.length;
  if (shortened >= shortForm.maxChars) {
    fail(
      "identifierShortForm must shorten: headChars + tailChars + ellipsis must be shorter than maxChars",
      "LIVE_DISPLAY_FORMAT_SHORT_FORM_USELESS",
    );
  }
  return Object.freeze(shortForm);
}

function normalizeNodeTaskLine(raw) {
  if (!raw || typeof raw !== "object") fail("nodeTaskLine must be an object");
  const sourceFields = stringList(raw.sourceFields, "nodeTaskLine.sourceFields");
  if (sourceFields.length === 0) fail("nodeTaskLine.sourceFields must not be empty");
  return Object.freeze({
    minChars: positiveInteger(raw.minChars, "nodeTaskLine.minChars"),
    sourceFields,
    duplicateOfFields: stringList(raw.duplicateOfFields, "nodeTaskLine.duplicateOfFields"),
  });
}

/** Validate and freeze a raw display-format document. */
export function normalizeLiveDisplayFormat(raw) {
  if (!raw || typeof raw !== "object") fail("document must be an object");
  if (raw.schemaVersion !== LIVE_DISPLAY_FORMAT_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${LIVE_DISPLAY_FORMAT_SCHEMA_VERSION}`, "LIVE_DISPLAY_FORMAT_SCHEMA_MISMATCH");
  }
  return Object.freeze({
    schemaVersion: raw.schemaVersion,
    emptyPlaceholder: requiredString(raw.emptyPlaceholder, "emptyPlaceholder"),
    identifierShortForm: normalizeIdentifierShortForm(raw.identifierShortForm),
    nodeTaskLine: normalizeNodeTaskLine(raw.nodeTaskLine),
    nonInformativeValues: foldedStringList(raw.nonInformativeValues, "nonInformativeValues"),
  });
}

/** Read and validate the shipped display-format document. */
export function loadLiveDisplayFormat(configUrl = LIVE_DISPLAY_FORMAT_CONFIG_URL) {
  const filePath = fileURLToPath(configUrl);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`cannot read ${filePath}: ${error.message}`, "LIVE_DISPLAY_FORMAT_UNREADABLE");
  }
  return normalizeLiveDisplayFormat(parsed);
}

/**
 * Shorten a long identifier while keeping both ends, so the result can still be
 * matched back to the run it names. Case is preserved: run ids are compared
 * literally elsewhere, and upper-casing them produces a string that matches
 * nothing.
 */
export function shortenIdentifier(value, shortForm) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text === "") return "";
  const form = shortForm && typeof shortForm === "object" ? shortForm : {};
  const maxChars = Number.isInteger(form.maxChars) && form.maxChars > 0 ? form.maxChars : 20;
  const ellipsis = typeof form.ellipsis === "string" && form.ellipsis !== "" ? form.ellipsis : "…";
  const headChars = Number.isInteger(form.headChars) && form.headChars > 0 ? form.headChars : 8;
  const tailChars = Number.isInteger(form.tailChars) && form.tailChars > 0 ? form.tailChars : 8;
  const characters = Array.from(text);
  if (characters.length <= maxChars) return text;
  if (headChars + tailChars + Array.from(ellipsis).length >= characters.length) return text;
  const head = characters.slice(0, headChars).join("");
  const tail = characters.slice(characters.length - tailChars).join("");
  return head + ellipsis + tail;
}

/**
 * Resolve the secondary task line of a graph node, or an empty string when that
 * line would add nothing. A line that merely repeats the node label or summary
 * is noise: it doubles the card height and tells the reader nothing new.
 */
export function resolveNodeTaskLine(node, policy) {
  const source = node && typeof node === "object" ? node : {};
  const config = policy && typeof policy === "object" ? policy : {};
  const rules = config.nodeTaskLine && typeof config.nodeTaskLine === "object" ? config.nodeTaskLine : {};
  const placeholder = typeof config.emptyPlaceholder === "string" ? config.emptyPlaceholder : "";
  const sourceFields = Array.isArray(rules.sourceFields) ? rules.sourceFields : ["task", "description"];
  const duplicateOfFields = Array.isArray(rules.duplicateOfFields) ? rules.duplicateOfFields : ["label", "summary"];
  const minChars = Number.isInteger(rules.minChars) && rules.minChars > 0 ? rules.minChars : 2;

  const clean = (value) => {
    if (typeof value !== "string") return "";
    const text = value.replace(/\s+/gu, " ").trim();
    if (text === "" || (placeholder !== "" && text === placeholder)) return "";
    return text;
  };

  let candidate = "";
  for (const field of sourceFields) {
    const value = clean(source[field]);
    if (value !== "") {
      candidate = value;
      break;
    }
  }
  if (candidate === "" || Array.from(candidate).length < minChars) return "";

  const folded = candidate.toLowerCase();
  for (const field of duplicateOfFields) {
    if (clean(source[field]).toLowerCase() === folded) return "";
  }
  return candidate;
}

/** Serialize the identifier shortener for inlining into the browser bundle. */
export function serializeIdentifierShortener() {
  return shortenIdentifier.toString();
}

/** Serialize the node-task resolver for inlining into the browser bundle. */
export function serializeNodeTaskLineResolver() {
  return resolveNodeTaskLine.toString();
}
