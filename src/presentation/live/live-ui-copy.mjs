/**
 * Product-owned Live UI copy. This is not a translator for task text or logs.
 * Each pattern describes a sentence composed by the renderer; its values are
 * inserted verbatim. Unknown text is preserved, never guessed or sent away.
 */
import { JA_COPY } from "./live-ui-copy.ja.mjs";
import { KO_COPY } from "./live-ui-copy.ko.mjs";

export const LIVE_UI_COPY = Object.freeze({ ja: JA_COPY, ko: KO_COPY });

const LIVE_UI_PATTERNS = Object.freeze([
  ["^Run ([A-Z0-9-]+)$", "Run {id}", ["id"]],
  ["^(.*) · (\\d+) of (\\d+) runs$", "{project} · {open} of {total} runs", ["project", "open", "total"]],
  ["^\\+ (\\d+) runs without an openable record$", "+ {count} runs without an openable record", ["count"]],
  ["^(.*) · (\\d+) runs$", "{project} · {count} runs", ["project", "count"]],
  ["^(.*) · no runs$", "{project} · no runs", ["project"]],
  ["^(.*) · (\\d+) observed run records$", "{project} · {count} observed run records", ["project", "count"]],
  ["^(\\d+) of (\\d+) steps complete$", "{done} of {total} steps complete", ["done", "total"]],
  ["^(\\d+) active workers?$", "{count} active workers", ["count"]],
  ["^(\\d+) workers?$", "{count} workers", ["count"]],
  ["^(\\d+) events?$", "{count} events", ["count"]],
  ["^Event (\\d+) of (\\d+)$", "Event {index} of {total}", ["index", "total"]],
  ["^Event (\\d+) of (\\d+): (.*)$", "Event {index} of {total}: {label}", ["index", "total", "label"]],
  ["^(\\d+) tools?$", "{count} tools", ["count"]],
  ["^(\\d+) tokens?$", "{count} tokens", ["count"]],
  ["^(.*) · waiting for its first governed run$", "{project} · waiting for its first governed run", ["project"]],
  ["^(\\d+) linked evidence items?$", "{count} linked evidence items", ["count"]],
  ["^(\\d+) evidence$", "{count} evidence", ["count"]],
  ["^(planned|observed) · (\\d+) evidence$", "{status} · {count} evidence", ["status", "count"]],
  ["^Tasks completed (\\d+)/(\\d+)$", "Tasks completed {done}/{total}", ["done", "total"]],
  ["^(\\d+) nodes$", "{count} nodes", ["count"]],
  ["^(\\d+) organization nodes collapsed$", "{count} organization nodes collapsed", ["count"]],
  ["^(\\d+) ownership hidden$", "{count} ownership hidden", ["count"]],
  ["^(\\d+) other relations hidden$", "{count} other relations hidden", ["count"]],
  ["^(\\d+) work nodes$", "{count} work nodes", ["count"]],
  ["^(\\d+) work items$", "{count} work items", ["count"]],
  ["^(\\d+) items$", "{count} items", ["count"]],
  ...["Live", "Selected", "Run ID", "Status", "Owner", "Runtime", "Model", "Duration", "Tools", "Tokens", "Loadout", "Prompt era", "Source"]
    .map((label) => ["^" + label + " · (.*)$", label + " · {value}", ["value"]]),
  ["^Run snapshot updated: (.*)$", "Run snapshot updated: {value}", ["value"]],
  ["^Last observed (.*)$", "Last observed {value}", ["value"]],
  ["^Selected node: (.*)$", "Selected node: {value}", ["value"]],
  ["^Replay (.*)$", "Replay {value}", ["value"]],
  ["^↳ from (.*)$", "↳ from {value}", ["value"]],
]);

/** Values such as project names, identifiers and recorded messages stay intact. */
export function translateLiveUiCopy(value, language) {
  const text = typeof value === "string" ? value : String(value ?? "");
  const copy = LIVE_UI_COPY[language];
  if (!copy || !text) return text;
  if (Object.prototype.hasOwnProperty.call(copy, text)) return copy[text];
  const trimmed = text.trim();
  if (Object.prototype.hasOwnProperty.call(copy, trimmed)) return copy[trimmed];
  for (const [pattern, key, fields] of LIVE_UI_PATTERNS) {
    const match = text.match(new RegExp(pattern, "u"));
    if (!match || !Object.prototype.hasOwnProperty.call(copy, key)) continue;
    const values = Object.fromEntries(fields.map((field, index) => [field, match[index + 1]]));
    // Only the renderer's closed status vocabulary is translated inside values.
    if (fields.includes("status")) values.status = copy[values.status] || values.status;
    if (key === "Status · {value}") values.value = copy[values.value] || values.value;
    return copy[key].replace(/\{([A-Za-z]+)\}/gu, (placeholder, field) => Object.prototype.hasOwnProperty.call(values, field) ? values[field] : placeholder);
  }
  // These prefixes are emitted by controls, never applied to record fields.
  for (const prefix of ["All relations ", "Dependencies ", "Input · ", "Out ", "Output measured ", "output tokens ", "Role · ", "AI worker · ", "Latest timed record · ", "Open result · ", "Current run · ", "Wave ", "Run ID ", "Node: ", "Project: ", "Run: ", "Next: ", "Deliverable: ", "Evidence: ", "Feedback ID: ", "Finding ID: ", "Version read this time: ", "Visible source reference: "]) {
    if (text.startsWith(prefix) && Object.prototype.hasOwnProperty.call(copy, prefix)) return copy[prefix] + text.slice(prefix.length);
  }
  const remaining = text.match(/^Show remaining (\d+) items$/u);
  if (remaining) return copy["Show remaining"] + " · " + remaining[1] + " " + copy.items;
  const roleCaption = text.match(/^(Investigation|Code implementation|Code review|Page design|Quality review|Subtask)( \d+)?$/u);
  if (roleCaption) return copy[roleCaption[1]] + (roleCaption[2] || "");
  if (text.includes(" · ")) return text.split(" · ").map((part) => translateLiveUiCopy(part, language)).join(" · ");
  return text;
}

export function liveUiLocale(language) {
  return ({ zh: "zh-CN", en: "en", ja: "ja-JP", ko: "ko-KR" })[language] || "en";
}

/** The browser runs the same renderer as the focused unit tests, offline. */
export function serializeLiveUiCopy() {
  const json = (value) => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  return `const LIVE_UI_COPY = ${json(LIVE_UI_COPY)};\nconst LIVE_UI_PATTERNS = ${json(LIVE_UI_PATTERNS)};\n${translateLiveUiCopy.toString()}\n${liveUiLocale.toString()}`;
}
