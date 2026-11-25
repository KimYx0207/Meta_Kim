import { isDeepStrictEqual } from "node:util";

export function hookCommandScriptPath(command) {
  const trimmed = String(command ?? "").trim();
  return trimmed.match(/^node\s+"([^"]+)"/u)?.[1]
    ?? trimmed.match(/^node\s+([^\s]+)/u)?.[1] ?? null;
}

function hookEntries(groups) {
  return groups.flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : [group])
    .map((hook) => ({ key: hookCommandScriptPath(hook?.command) ?? hook?.command,
      hook, matcher: group?.matcher ?? null })));
}

export function describeGlobalHookDrift(current, expected, managedEvents) {
  const diagnostics = [];
  for (const event of managedEvents) {
    const before = current?.[event] ?? [];
    const after = expected?.[event] ?? [];
    if (isDeepStrictEqual(before, after)) continue;
    if (!Array.isArray(before) || !Array.isArray(after)) {
      diagnostics.push(`${event}: unexpected event structure`);
      continue;
    }
    const actual = hookEntries(before);
    const wanted = hookEntries(after);
    const used = new Set();
    let changed = 0;
    let order = false;
    let previous = -1;
    for (const entry of actual) {
      const matches = (candidate, index) => !used.has(index) && candidate.key === entry.key;
      let index = wanted.findIndex((candidate, position) => matches(candidate, position) && isDeepStrictEqual(candidate, entry));
      if (index < 0) index = wanted.findIndex(matches);
      if (index < 0) continue;
      used.add(index);
      if (!isDeepStrictEqual(wanted[index], entry)) changed += 1;
      if (index < previous) order = true;
      previous = index;
    }
    const missing = wanted.length - used.size;
    const extra = actual.length - used.size;
    const shape = (groups) => groups.map((group) => Array.isArray(group?.hooks) ? group.hooks.length : null);
    const grouping = !missing && !extra && !isDeepStrictEqual(shape(before), shape(after));
    const details = [`missing=${missing}`, `extra=${extra}`, `changed=${changed}`];
    if (order) details.push("order differs");
    if (grouping) details.push("grouping differs");
    if (!missing && !extra && !changed && !order && !grouping) details.push("group metadata differs");
    diagnostics.push(`${event}: ${details.join(", ")}`);
  }
  return diagnostics;
}
