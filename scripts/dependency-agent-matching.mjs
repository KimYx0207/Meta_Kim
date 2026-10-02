const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const stopWords = new Set([
  "用户", "提供", "根据", "明确", "需要", "当前", "使用", "内容", "没有", "一个", "一些", "这些", "什么", "怎样", "怎么",
  "是否", "哪些", "如何", "为什么", "一直", "不要", "自己", "项目", "目标", "清单", "修改", "知道", "不知", "不知道", "帮我", "帮助", "完成", "整理", "检查", "给出", "相关", "情况", "结果", "合适", "这个", "那个", "一下", "我的", "你的", "我们", "你们", "本次", "本轮",
  "this", "that", "with", "from", "help", "writer", "planner", "editor", "analyst", "assist", "when", "user",
]);

function normalized(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase();
}

function terms(value) {
  const segments = [...segmenter.segment(normalized(value))];
  const words = segments
    .filter((part) => part.isWordLike)
    .map((part) => part.segment);
  // ICU may split ordinary words such as 选题 or 排期 into adjacent Han
  // characters depending on context. Retain those pairs without a role lexicon.
  for (let index = 0; index < segments.length - 1; index += 1) {
    const left = segments[index];
    const right = segments[index + 1];
    if (/^\p{Script=Han}$/u.test(left.segment) && /^\p{Script=Han}$/u.test(right.segment)
      && !/^[的地得了着把被和与在我你他她它给]$/u.test(left.segment)
      && !/^[的地得了着把被和与在我你他她它给]$/u.test(right.segment)
      && left.index + left.segment.length === right.index) words.push(left.segment + right.segment);
  }
  return new Set(words.filter((term) => term.length >= 2 && !/^\d+$/u.test(term) && !stopWords.has(term)));
}

// Candidate ranking uses the package's own positive trigger evidence. It does
// not execute the role, waive its exclusions, or turn an ambiguous match into
// a product decision. No industry-to-owner routing table lives here.
export function matchDependencyAgentContracts(request, agents = []) {
  const requestText = normalized(request);
  const requestTerms = terms(request);
  // In "把报价进度写成周报", 报价 names the input while 周报 names the
  // requested deliverable. Give that explicit transformation target priority.
  const deliverableText = requestText.match(/(?:写成|改成|整理成|做成|改写为|转换为)([^，。；;！？!?]*)/u)?.[1] ?? "";
  const deliverableTerms = terms(deliverableText);
  const candidates = agents.filter((agent) => agent.routeEligible !== false);
  const documents = candidates.map((agent) => {
    const title = agent.displayName ?? String(agent.description ?? "").split(/[：:]/u)[0];
    return {
      agent,
      titleWords: terms(title),
      words: terms([agent.componentId, title, ...(agent.trigger ?? [])].join(" ")),
    };
  });
  const frequency = new Map();
  for (const { words } of documents) for (const word of words) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const scores = documents.map(({ agent, words, titleWords }) => {
    const matchedTerms = [...words].filter((word) => requestTerms.has(word)
      || (/\p{Script=Han}/u.test(word) && requestText.includes(word)));
    const exactName = requestText.includes(normalized(agent.id)) || requestText.includes(normalized(agent.componentId));
    const phraseMatch = (agent.trigger ?? []).some((trigger) => {
      const quotes = [...trigger.matchAll(/「([^」]+)」/gu)].map((match) => match[1]);
      return (quotes.length ? quotes : [trigger]).some((quote) => quote.length >= 4 && requestText.includes(normalized(quote)));
    });
    const score = matchedTerms.reduce((total, word) => total + 8 / frequency.get(word)
      + (titleWords.has(word) ? 16 : 0)
      + (deliverableTerms.has(word) || (/\p{Script=Han}/u.test(word) && deliverableText.includes(word)) ? 16 : 0), 0)
      + (exactName ? 64 : 0) + (phraseMatch ? 16 : 0);
    return { agent, score, matchedTerms };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.agent.id.localeCompare(b.agent.id));
  const best = scores[0];
  const ambiguous = Boolean(best && scores[1] && best.score - scores[1].score < 2);
  const selected = best && best.score >= 8 && !ambiguous ? best.agent : null;
  return {
    selected,
    candidates: scores.slice(0, 5).map(({ agent, score, matchedTerms }) => ({ id: agent.id, score, matchedTerms })),
    reason: selected ? "matched_contract_trigger_evidence" : ambiguous ? "ambiguous_contract_matches" : "no_specific_contract_match",
    invocationStatus: "not_invoked",
  };
}
