// Shared, side-effect-free interpretation of durable capability requests.
// Selection and materialization must agree on the user's requested lifecycle.

export function safeSlug(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "capability";
}

function asksOnlyForCapabilityCreationDecision(line) {
  const text = String(line ?? "");
  const explicitlyForbidsMutation =
    /(?:只做|仅做|只需|仅需)(?:判断|评估|分析|检查|审查)|不要(?:写入|创建|新建|生成|修改|落盘|执行)|不(?:要|需)(?:写入|创建|新建|生成|修改|落盘|执行)|只读|read[- ]?only|do\s+not\s+(?:write|create|modify|apply)|without\s+(?:writing|creating|modifying|applying)/iu.test(text);
  if (explicitlyForbidsMutation) return true;
  const asksWhether =
    /是否(?:需要|应该|要)?(?:创建|新建|生成|固化|沉淀)|需不需要(?:创建|新建|生成|固化|沉淀)|要不要(?:创建|新建|生成|固化|沉淀)|有没有必要(?:创建|新建|生成|固化|沉淀)|whether\s+(?:we\s+)?(?:need|should)\s+to\s+(?:create|add|persist|generate)|do\s+we\s+need\s+to\s+(?:create|add|persist|generate)/iu.test(text);
  if (!asksWhether) return false;
  const alsoAuthorizesMutation =
    /(?:请|直接|立即|马上|务必)(?:把|将)?\s*(?:创建|新建|生成|固化|沉淀|写入|安装|新增|添加|升级)|(?:创建|新建|生成|固化|沉淀|写入|安装|新增|添加|升级)(?:到|至|在)(?:当前|本)?项目|项目(?:里|内)长期维护|(?:please\s+)?(?:create|add|persist|generate)\s+(?:it|this|the\s+capability)\s+(?:now|in\s+the\s+project)/iu.test(text);
  return !alsoAuthorizesMutation;
}

function explicitCapabilityIdFromLine(line, decision) {
  const keyword = decision === "create_agent"
    ? "agent|智能体|代理"
    : decision === "create_skill"
      ? "skill|技能"
      : decision === "create_command"
        ? "command|命令"
        : null;
  if (!keyword) return null;
  const match = String(line ?? "").match(
    new RegExp(`(?:${keyword})\\s*(?:名为|叫做|called|named|:|：)?\\s*[\\x60'\"]?([a-z0-9][a-z0-9._-]{1,79})`, "iu"),
  );
  return match?.[1]?.toLowerCase() ?? null;
}

function durableCapabilitySpecificationReady(line, explicitCapabilityId) {
  if (!explicitCapabilityId) return false;
  const text = String(line ?? "");
  return (
    text.length >= explicitCapabilityId.length + 16 &&
    /负责|用于|处理|审查|审核|验证|生成|同步|检查|执行|维护|拒绝|边界|responsib|purpose|handles?|reviews?|verif|generat|sync|check|execute|maintain|refus|boundary/iu.test(text)
  );
}

function explicitlyRequestsDurableCapabilityAction(line, decision) {
  const text = String(line ?? "")
    .replace(
      /(?:不要|不需要|无需|不应|禁止|拒绝)\s*(?:再|进行|执行)?\s*(?:新建|创建|生成|固化|沉淀|写入|安装|新增|添加|复制|迭代|修改|升级|定制|复用)/giu,
      "",
    )
    .replace(
      /(?:do\s+not|don't|without|no\s+need\s+to|refuse\s+to)\s*(?:create|add|persist|generate|install|copy|iterate|modify|upgrade|customize|reuse)/giu,
      "",
    );
  const chineseAction = "新建|创建|固化|沉淀|写入|安装|新增|添加|复制|迭代|修改|升级|定制|复用";
  const capabilityType = decision === "create_agent"
    ? "agent|智能体|代理"
    : decision === "create_skill"
      ? "skill|技能"
      : decision === "create_command"
        ? "command|命令"
        : decision === "create_hook"
          ? "hook|钩子"
          : decision === "create_mcp_provider"
            ? "mcp(?:\\s+provider)?|mcp服务|mcp工具"
            : "script|脚本";
  const chineseContext = "(?:(?:在|于|把|将|对|为|当前|本|这个|该|全局|项目|仓库)\\s*){0,6}";
  const englishContext = "(?:(?:the|this|a|an|global|project|repository|repo)\\s+){0,5}";
  return (
    new RegExp(`(?:请|需要|需|应当|应该|务必|直接|立即|马上|帮我)\\s*${chineseContext}(?:${chineseAction}|生成)\\s*${chineseContext}(?:${capabilityType})`, "iu").test(text) ||
    new RegExp(`(?:^|[。；;\\n])\\s*(?:${chineseAction}|生成)\\s*(?:一个|新的?)?\\s*(?:${capabilityType})`, "iu").test(text) ||
    new RegExp(`(?:please|need\\s+to|should|must|help\\s+me)\\s+${englishContext}(?:create|add|persist|generate|install|copy|iterate|modify|upgrade|customize|reuse)\\s+${englishContext}(?:${capabilityType})`, "iu").test(text) ||
    new RegExp(`(?:^|[.;\\n])\\s*(?:create|add|persist|generate|install|copy|iterate|modify|upgrade|customize|reuse)\\s+(?:an?\\s+|the\\s+)?(?:${capabilityType})`, "iu").test(text)
  );
}

export function durableCapabilityRequestsFromTask(task, runId = "meta-run") {
  const lines = String(task ?? "")
    .split(/\r?\n|。|；|;/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const requests = [];
  for (const [index, line] of lines.entries()) {
    if (asksOnlyForCapabilityCreationDecision(line)) continue;
    const lower = line.toLowerCase();
    const explicitDeclaredDecision = /(?:\bagent\b|智能体|代理)\s*(?:名为|叫做|called|named|:|：)?\s*[\x60'"]?[a-z0-9][a-z0-9._-]{1,79}/iu.test(line)
      ? "create_agent"
      : /(?:\bskill\b|技能)\s*(?:名为|叫做|called|named|:|：)?\s*[\x60'"]?[a-z0-9][a-z0-9._-]{1,79}/iu.test(line)
        ? "create_skill"
        : /(?:\bcommand\b|命令)\s*(?:名为|叫做|called|named|:|：)?\s*[\x60'"]?[a-z0-9][a-z0-9._-]{1,79}/iu.test(line)
          ? "create_command"
          : null;
    const decision = explicitDeclaredDecision ?? (/\bmcp\b|mcp provider|mcp 工具|mcp服务|mcp provider 边界/i.test(line)
      ? "create_mcp_provider"
      : /\bhook\b|钩子/i.test(line)
        ? "create_hook"
        : /\bcommand\b|命令/i.test(line)
          ? "create_command"
      : /脚本|script|json/.test(lower)
        ? "create_script"
        : /\bagent\b|智能体|代理|owner|负责人|长期/u.test(lower)
          ? "create_agent"
          : /\bskill\b|技能|标准|standard|沉淀|可复用|reusable|recurring|重复/.test(lower)
            ? "create_skill"
            : null);
    if (!decision) continue;
    const explicitNeed = /需要|should|candidate|沉淀|可复用|直接复用|复用|reusable|reuse|recurring|重复|长期|迭代|修改|升级|定制|新建|创建|keeps recurring|iterate|modify|upgrade|customize|create/i.test(line);
    if (!explicitNeed) continue;
    const explicitCapabilityId = explicitCapabilityIdFromLine(line, decision);
    const requestedCapability =
      decision === "create_skill" && /prd\s*review\s*standard/i.test(line)
        ? "prd-review-standard-skill"
        : explicitCapabilityId ?? (safeSlug(line).slice(0, 80) || `${decision}-${index + 1}`);
    requests.push({
      requestId: `${runId}-durable-${index + 1}`,
      sourceText: line,
      requestedCapability,
      explicitCapabilityId,
      specificationReady: durableCapabilitySpecificationReady(line, explicitCapabilityId),
      mutationAuthorized: explicitlyRequestsDurableCapabilityAction(line, decision),
      decision,
      requestedAction:
        /迭代|修改|升级|定制|iterate|modify|upgrade|customize/i.test(line)
          ? "iterate"
          : /新建|创建|create|new project/i.test(line)
            ? "create"
            : "reuse",
      candidateType:
        decision === "create_agent"
          ? "agent"
          : decision === "create_skill"
            ? "skill"
            : decision === "create_command"
              ? "command"
              : decision === "create_hook"
                ? "hook"
            : decision === "create_script"
              ? "script"
              : "mcp_provider",
    });
  }
  return requests;
}
