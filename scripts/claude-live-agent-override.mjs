function parseQuotedScalar(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  return value;
}

export function parseClaudeAgentFrontmatter(sourceText) {
  const match = String(sourceText).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) throw new Error("Claude runtime agent definition is missing YAML frontmatter");

  const fields = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const field = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/u);
    if (!field) continue;
    fields[field[1]] = parseQuotedScalar(field[2]);
  }
  return fields;
}

export function buildClaudeSafeModeAgentOverride(sourceText, expectedAgentId) {
  const fields = parseClaudeAgentFrontmatter(sourceText);
  const agentId = String(fields.name ?? "").trim();
  if (!agentId || agentId !== expectedAgentId) {
    throw new Error(
      `Claude runtime agent definition name mismatch: expected ${expectedAgentId}, got ${agentId || "missing"}`,
    );
  }

  const description = String(fields.description ?? "").trim();
  const owns = String(fields.own ?? "").trim();
  const refuses = String(fields.do_not_touch ?? "").trim();
  const boundary = String(fields.boundary ?? "").trim();
  if (!description || !owns || !refuses || !boundary) {
    throw new Error(
      `Claude runtime agent definition ${agentId} is missing description, own, do_not_touch, or boundary`,
    );
  }

  const trigger = String(fields.trigger ?? "").trim();
  const prompt = [
    `You are ${agentId}, loaded from an installed Meta_Kim Claude Code runtime definition.`,
    `Description: ${description}`,
    `Own: ${owns}`,
    `Do not touch: ${refuses}`,
    `Boundary: ${boundary}`,
    ...(trigger ? [`Trigger: ${trigger}`] : []),
    "This is a governance-layer agent. Do not perform business implementation or execution work. Delegate work outside the stated owner boundary.",
  ].join("\n");

  return {
    [agentId]: {
      description,
      prompt,
    },
  };
}

export function redactClaudeLiveCommandText(value, sensitiveValues = []) {
  let redacted = String(value ?? "");
  for (const sensitiveValue of sensitiveValues) {
    const text = String(sensitiveValue ?? "");
    if (!text) continue;
    redacted = redacted.split(text).join("<redacted-claude-live-input>");
  }
  return redacted;
}
