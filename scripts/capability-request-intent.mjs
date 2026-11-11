// Shared, side-effect-free interpretation of durable capability requests.
// Selection and materialization must agree on the user's requested lifecycle.

const chineseContext = "(?:(?:在|于|把|将|对|为|当前|本|这个|该|全局|项目|仓库)\\s*){0,6}";
const englishContext = "(?:(?:the|this|a|an|global|project|repository|repo)\\s+){0,5}";
const chineseAction = "新建|创建|生成|固化|沉淀|写入|安装|新增|添加|复制|迭代|修改|升级|定制|复用";
const englishAction = "create|add|persist|generate|install|copy|iterate|modify|upgrade|customize|reuse";
const declaredCapabilityTypes = [
  { decision: "create_agent", keyword: "\\bagent\\b|智能体|代理" },
  { decision: "create_skill", keyword: "\\bskill\\b|技能" },
  { decision: "create_command", keyword: "\\bcommand\\b|命令" },
];

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

function explicitCapabilityDeclarationsFromLine(line) {
  return declaredCapabilityTypes.flatMap(({ decision, keyword }) => {
    const pattern = new RegExp(`(?:${keyword})\\s*(名为|叫做|called|named|:|：)?\\s*[\\x60'\"]?([a-z0-9][a-z0-9._-]{1,79})`, "giu");
    return [...line.matchAll(pattern)].flatMap((match) => {
      // Grammar and pronouns are unresolved targets, unless deliberately named.
      if (!match[1] && /^(?:unless|if|when|once|after|before|for|to|is|are|that|which|should|must|candidate-only|it|this|them|these|those|and|or)$/iu.test(match[2])) return [];
      const nameEnd = match.index + match[0].length;
      return [{ decision, id: match[2].toLowerCase(), nameStart: nameEnd - match[2].length, nameEnd }];
    });
  }).sort((left, right) => left.nameStart - right.nameStart);
}

function outsideCapabilityNames(line) {
  return explicitCapabilityDeclarationsFromLine(line).reduceRight((text, declaration) =>
    `${text.slice(0, declaration.nameStart)}${" ".repeat(declaration.nameEnd - declaration.nameStart)}${text.slice(declaration.nameEnd)}`, line);
}

function mutationIsDeferred(line) {
  return /\bcandidate[- ]only\b|\bunless\s+\w|\bonly\s+if\b|\b(?:pending|awaiting|after|before|until)\s+(?:warden\s+)?approval\b|仅(?:作为|做)?候选|只(?:作为|做)?候选|(?:批准|审批|确认)后|待(?:批准|审批|确认)/iu.test(outsideCapabilityNames(line));
}

function capabilityRequestClauses(task) {
  // A period inside alpha.v1 is part of the name; a sentence stop is not.
  const sentences = String(task ?? "").split(/\r?\n|。|；|;|\.(?=\s|$)/u).map((line) => line.trim()).filter(Boolean);
  const deferred = sentences.map(mutationIsDeferred);
  const standaloneConditions = sentences.map((line, index) => deferred[index] && !/\bagent\b|\bskill\b|\bcommand\b|\bmcp\b|\bhook\b|\bscript\b|智能体|代理|技能|命令|钩子|脚本/iu.test(line));
  const readOnly = sentences.some((line) => /^(?:this\s+task\s+is\s+)?(?:read[- ]?only\b|只读)/iu.test(line));
  return sentences.flatMap((sentence, index) => {
    const mutationBlocked = readOnly || deferred[index] || standaloneConditions[index - 1] || standaloneConditions[index + 1] || false;
    // Split independent actions without losing the parent sentence's condition.
    // Mask names first so a literal identifier such as "named then" is intact.
    const separators = [...outsideCapabilityNames(sentence).matchAll(/(?:[,，]\s*)?(?:\bthen\b|然后)\s*[,，]?\s*/giu)];
    let start = 0;
    const clauses = [];
    for (const separator of separators) {
      clauses.push(sentence.slice(start, separator.index));
      start = separator.index + separator[0].length;
    }
    clauses.push(sentence.slice(start));
    return clauses.map((line) => ({ line: line.trim(), mutationBlocked })).filter(({ line }) => line);
  });
}

function durableCapabilitySpecificationReady(line, explicitCapabilityId) {
  if (!explicitCapabilityId) return false;
  const text = String(line ?? "");
  return (
    text.length >= explicitCapabilityId.length + 16 &&
    /负责|用于|处理|审查|审核|验证|生成|同步|检查|执行|维护|拒绝|边界|responsib|purpose|handles?|reviews?|verif|generat|sync|check|execute|maintain|refus|boundary/iu.test(text)
  );
}

function positiveCapabilityActionText(line) {
  // Mask the entire coordinated denial, including location qualifiers. Keeping
  // offsets stable lets lifecycle and target selection inspect the same text.
  return String(line ?? "")
    .replace(
      new RegExp(`(?:不要|不需要|无需|不应|禁止|拒绝|不)\\s*(?:再|进行|执行)?\\s*${chineseContext}(?:${chineseAction})(?:\\s*(?:或者|或|和|与|及|、)\\s*${chineseContext}(?:${chineseAction}))*`, "giu"),
      (match) => " ".repeat(match.length),
    )
    .replace(
      new RegExp(`\\b(?:do\\s+not\\s+need\\s+to|don't\\s+need\\s+to|do\\s+not|don't|without|no\\s+need\\s+to|refuse\\s+to)\\s+${englishContext}(?:${englishAction})\\b(?:\\s+(?:or|and)\\s+(?:to\\s+)?${englishContext}(?:${englishAction})\\b)*`, "giu"),
      (match) => " ".repeat(match.length),
    );
}

function explicitlyRequestsDurableCapabilityAction(line, decision, declaration) {
  if (mutationIsDeferred(line)) return false;
  if (declaredCapabilityTypes.some((type) => type.decision === decision) && !declaration) return false;
  const text = positiveCapabilityActionText(line);
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
  return (
    new RegExp(`(?:请|需要|需|应当|应该|务必|直接|立即|马上|帮我)\\s*${chineseContext}(?:${chineseAction})\\s*${chineseContext}(?:${capabilityType})`, "iu").test(text) ||
    new RegExp(`(?:^|[。；;\\n])\\s*(?:${chineseAction})\\s*(?:一个|新的?)?\\s*(?:${capabilityType})`, "iu").test(text) ||
    new RegExp(`(?:please|need\\s+to|should|must|help\\s+me)\\s+${englishContext}(?:${englishAction})\\s+${englishContext}(?:${capabilityType})`, "iu").test(text) ||
    new RegExp(`(?:^|[.;\\n])\\s*(?:${englishAction})\\s+(?:an?\\s+|the\\s+)?(?:${capabilityType})`, "iu").test(text)
  );
}

export function durableCapabilityRequestsFromTask(task, runId = "meta-run") {
  const requests = [];
  for (const [index, { line, mutationBlocked }] of capabilityRequestClauses(task).entries()) {
    const actionText = positiveCapabilityActionText(line);
    if (asksOnlyForCapabilityCreationDecision(actionText)) continue;
    const lower = line.toLowerCase();
    const declarations = explicitCapabilityDeclarationsFromLine(actionText);
    // Type references in the purpose are context, not additional write targets.
    const first = declarations[0];
    const purposeOffset = first ? actionText.slice(first.nameEnd).search(/\bfor\b|\bresponsib|\bpurpose\b|负责|用于|处理|审查|验证|检查/iu) : -1;
    const targets = declarations.filter((declaration) => purposeOffset < 0 || declaration.nameStart < first.nameEnd + purposeOffset);
    const explicitDeclaredDecision = first?.decision;
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
    // Negated actions describe a boundary, not a request to create a candidate.
    // Keep affirmative actions elsewhere (e.g. create a skill that must not
    // modify user files), while stripping the denied verb before all decisions.
    const explicitNeed = /需要|should|candidate|沉淀|可复用|直接复用|复用|reusable|reuse|recurring|重复|长期|迭代|修改|升级|定制|新建|创建|keeps recurring|iterate|modify|upgrade|customize|create/i.test(actionText);
    if (!explicitNeed) continue;
    const declaration = targets.length === 1 ? targets[0] : null;
    const explicitCapabilityId = declaration?.id ?? null;
    const lifecycleText = declaration ? actionText.slice(0, declaration.nameStart) : actionText;
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
      mutationAuthorized: !mutationBlocked && explicitlyRequestsDurableCapabilityAction(line, decision, declaration),
      decision,
      requestedAction:
        /迭代|修改|升级|定制|iterate|modify|upgrade|customize/i.test(lifecycleText)
          ? "iterate"
          : /新建|创建|create|new project/i.test(lifecycleText)
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
