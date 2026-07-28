function payload(record) {
  return record?.payload ?? record;
}

function lineIds(record) {
  const body = payload(record);
  const item = record?.item ?? body?.item ?? body;
  const ids = new Set([
    record?.call_id,
    record?.callId,
    body?.call_id,
    body?.callId,
    body?.tool_use_id,
    item?.id,
    item?.call_id,
  ].filter((value) => typeof value === "string" && value));
  for (const entry of body?.message?.content ?? []) {
    for (const value of [entry?.id, entry?.tool_use_id, entry?.call_id]) if (typeof value === "string" && value) ids.add(value);
  }
  return ids;
}

function terminalState(record) {
  const body = payload(record);
  const item = record?.item ?? body?.item ?? body;
  const type = String(record?.type ?? body?.type ?? item?.type ?? "").toLowerCase();
  const status = String(item?.status ?? body?.status ?? "").toLowerCase();
  const messageResult = (body?.message?.content ?? []).some((entry) => entry?.type === "tool_result");
  const terminal = messageResult || /(?:item\.)?completed|tool_result|tool_use_result|function_call_output|custom_tool_call_output|patch_apply_end/u.test(type) ||
    ["completed", "returned", "declined", "failed", "cancelled", "canceled", "error"].includes(status);
  if (!terminal) return null;
  const exitCode = item?.exit_code ?? body?.exit_code ?? body?.exitCode;
  const failed = ["declined", "failed", "cancelled", "canceled", "error"].includes(status) ||
    (Number.isInteger(exitCode) && exitCode !== 0) || item?.is_error === true || body?.is_error === true ||
    (type === "patch_apply_end" && body?.success === false) ||
    (body?.message?.content ?? []).some((entry) => entry?.type === "tool_result" && entry?.is_error === true);
  return failed ? "failed" : "succeeded";
}

export function assertExactMarkerEventLifecycles(rawText, marker, expectedEventIds) {
  const parsed = String(rawText).split(/\r?\n/u).filter(Boolean).map((line) => {
    try { return { line, record: JSON.parse(line) }; } catch { return null; }
  }).filter(Boolean);
  const markerIds = parsed.filter(({ line }) => line.includes(marker)).flatMap(({ record }) => [...lineIds(record)]);
  const ids = expectedEventIds == null ? markerIds : expectedEventIds;
  for (const eventId of new Set(ids)) {
    const related = parsed.filter(({ record }) => lineIds(record).has(eventId));
    if (!related.some(({ line }) => line.includes(marker))) throw new Error(`marker lifecycle ${eventId} has no marker-bound input/start event`);
    const terminals = related.map(({ record }) => terminalState(record)).filter(Boolean);
    if (terminals.length === 0) throw new Error(`marker lifecycle ${eventId} has missing terminal evidence`);
    if (terminals.includes("failed")) throw new Error(`marker lifecycle ${eventId} terminated as declined, failed, cancelled, or nonzero`);
  }
}
