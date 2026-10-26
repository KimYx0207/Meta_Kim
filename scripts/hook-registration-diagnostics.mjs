import path from "node:path";

/** Parse only a direct Node invocation. Never evaluate shell syntax. */
export function parseNodeHookCommand(command) {
  if (typeof command !== "string" || command.length > 16384 || /[\r\n;&|<>`$]/u.test(command)) return null;
  const tokens = [];
  let token = "", quote = null, started = false;
  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === '"' || character === "'") { quote = character; started = true; }
    else if (/\s/u.test(character)) {
      if (started) { tokens.push(token); token = ""; started = false; }
    } else { token += character; started = true; }
  }
  if (quote) return null;
  if (started) tokens.push(token);
  if (!/^(?:.*[\\/])?node(?:\.exe)?$/iu.test(tokens[0] || "") || !tokens[1] || tokens[1].startsWith("-")) return null;
  return { script: tokens[1].replace(/\\\\/gu, "\\"), args: tokens.slice(2) };
}

export function collectHookRegistrations(hooks) {
  const result = [];
  for (const [event, blocks] of Object.entries(hooks || {})) {
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      for (const hook of Array.isArray(block?.hooks) ? block.hooks : [block]) {
        if (!hook || (hook.type && hook.type !== "command") || typeof hook.command !== "string") continue;
        const parsed = parseNodeHookCommand(hook.command);
        result.push({ event, matcher: block.matcher || "", command: hook.command, ...parsed });
      }
    }
  }
  return result;
}

function absoluteScript(value, projectRoot) {
  const windows = /^[a-z]:[\\/]/iu.test(projectRoot || "") || /^[a-z]:[\\/]/iu.test(value) || /^\\\\/u.test(value);
  const paths = windows ? path.win32 : path;
  // Relative paths are meaningful only within the trusted configuration root.
  if (!paths.isAbsolute(value) && (!projectRoot || !paths.isAbsolute(projectRoot))) return null;
  const absolute = paths.resolve(projectRoot || paths.parse(value).root, value).replace(/\\/gu, "/");
  return windows || process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function sameScript(found, expected, projectRoot) {
  if (!found || !expected) return false;
  const required = absoluteScript(expected, projectRoot);
  return required !== null && absoluteScript(found, projectRoot) === required;
}

function requiredArgsPresent(found, expected) {
  for (let index = 0; index < expected.length; index += 2) {
    const flag = expected[index], value = expected[index + 1];
    const positions = found.flatMap((argument, i) => argument === flag ? [i] : []);
    if (positions.length !== 1 || found[positions[0] + 1] !== value) return false;
  }
  return true;
}

/** Validate a required subset; unrelated user registrations remain untouched. */
export function inspectRequiredHooks(actualHooks, expectedHooks, { projectRoot = process.cwd() } = {}) {
  const actual = collectHookRegistrations(actualHooks);
  const required = collectHookRegistrations(expectedHooks);
  const missing = required.filter((item) => !actual.some((candidate) =>
    candidate.event === item.event && candidate.matcher === item.matcher && sameScript(candidate.script, item.script, projectRoot)
    && requiredArgsPresent(candidate.args || [], item.args || [])));
  return { ok: missing.length === 0, requiredCount: required.length, observedCount: actual.length,
    missing: missing.map(({ event, matcher, script, args }) => ({ event, matcher, script, args })) };
}
