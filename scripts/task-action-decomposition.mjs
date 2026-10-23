/**
 * Conservative lexical task decomposition, not a natural-language planner.
 * Only explicit action boundaries and ordering cues establish task structure.
 */
const ACTION_START = /^(?:(?:and|also)\s+)?(?:(?:first|then|next|finally|afterwards|subsequently)\b[,:]?\s*|lane\s+[\w-]+\s*[:：]\s*)?(?:inspect|check|review|audit|analy[sz]e|verify|investigate|read|use|derive|compare|test|fix|implement|build|refactor|rebuild|migrate|write|edit|update|delete|remove|deploy|publish|release|upload|send|create|run)\b|^(?:(?:首先|然后|接着|随后|最后|同时|并行|先|再)[，,:：]?\s*)?(?:据此\s*)?(?:检查|审查|审核|分析|验证|排查|读取|阅读|使用|对照|测试|修复|修改|实现|构建|重构|迁移|写入|编辑|更新|删除|移除|部署|发布|上传|发送|创建)/iu;
const LATER_STEP = /^(?:(?:and|also)\s+)?(?:then|next|finally|afterwards|subsequently)\b|^(?:然后|接着|随后|最后|再|据此)/iu;
const FIRST_STEP = /^(?:first\b|首先|先)/iu;
const META_ONLY = /^(?:(?:run|use|execute)\s+)?(?:meta[- ]theory|元理论)[.!。！]?$/iu;
const PARALLEL_ONLY = /^(?:(?:two|three|four|\d+)\s+)?(?:independent\s+)?parallel\s+(?:lanes|tasks|agents)[.!]?$/iu;
const EXPLICIT_PARALLEL = /\b(?:in\s+parallel|independent(?:ly)?\s+(?:parallel\s+)?(?:lanes|tasks|reviews|checks)|parallel\s+(?:lanes|tasks|agents)|concurrently)\b|并行(?:执行|检查|审查|啊|[：:\s])|独立执行|同时(?:检查|审查|执行)/iu;
const NEGATIVE_PARALLEL = /\b(?:not|never|avoid|without|cannot)\b[^\n.;]{0,60}\b(?:parallel|independent(?:ly)?|concurrently)\b|\bparallel\b[^\n.;]{0,40}\b(?:unsafe|unknown|unproven|uncertain)\b|(?:不|不能|不要|不得|禁止|避免)[^\n。；]{0,30}(?:并行|独立|同时)/iu;
const PARALLEL_FEASIBILITY = /\b(?:can|could|would|should|may|might|whether|if)\b[^\n.;!?]{0,80}\b(?:parallel|independent(?:ly)?|concurrently)\b|(?:parallel|independent(?:ly)?|concurrently|并行|独立|同时)[^\n.;!?。；！？]*[?？]|(?:能否|是否|可否|能不能|可不可以)[^\n。；]{0,30}(?:并行|独立|同时)/iu;
const RESULT_REFERENCE = /\b(?:findings|results?|output|produced|derived|depends?\s+on|based\s+on|after)\b|依赖|基于|依据|结果|产出|完成后/iu;
const QUOTE_END = new Map([['"', '"'], ["'", "'"], ["`", "`"], ["“", "”"], ["‘", "’"]]);

/** Quoted material and path tokens cannot assert an execution relationship. */
function dependencyAssertionText(text) {
  return text.replace(/(^|[\s(:：])(["'`“‘])([^\n]*?)(["'`”’])/gu, (whole, _prefix, open, _content, close) => QUOTE_END.get(open) === close ? " ".repeat(whole.length) : whole)
    .replace(/\S*[\\/]\S*/gu, " ")
    // Apostrophes inside contractions are not quotes. Both ASCII and typographic
    // contractions must retain their negative meaning for readiness checks.
    .replace(/\b([a-z]+)n['’]t\b/giu, "$1 not");
}

/** Return explicit path spellings without normalizing case or separators. */
export function extractActionPaths(text) {
  const paths = [];
  const add = (value) => {
    if (!value || /^[a-z][a-z\d+.-]*:\/\//iu.test(value)) return;
    if (/[\\/]/u.test(value) || /^[\p{L}\p{N}_@.-]+\.(?:[cm]?js|[jt]sx?|json|md|ya?ml|toml|py|go|rs|css|html|sql|sh|ps1)$/iu.test(value)) {
      if (!paths.includes(value)) paths.push(value);
    }
  };
  const unquoted = String(text ?? "").replace(/(["'`“‘])([^\n]*?)(["'`”’])/gu, (whole, open, content, close) => {
    if (QUOTE_END.get(open) !== close) return whole;
    add(content);
    return " ".repeat(whole.length);
  });
  for (const token of unquoted.split(/[\s,;，；、。！？]+/u)) {
    add(token.replace(/^[([{]+|[)\]}.!?:]+$/gu, ""));
  }
  return paths;
}

/** Split explicit clauses while protecting quoted paths, URLs and file dots. */
function explicitClauses(text) {
  const clauses = [];
  let start = 0;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (QUOTE_END.has(character) && (index === 0 || /[\s(:：]/u.test(text[index - 1]))) {
      quote = QUOTE_END.get(character);
      continue;
    }
    const rest = text.slice(index + 1).trimStart();
    const hardBoundary = /[\n;；。！？]/u.test(character);
    const sentenceBoundary = /[.!?]/u.test(character) && /\s/u.test(text[index + 1] ?? "");
    const actionComma = /[,，]/u.test(character) && ACTION_START.test(rest);
    if (!hardBoundary && !sentenceBoundary && !actionComma) continue;
    const clause = text.slice(start, index).trim();
    if (clause) clauses.push(clause);
    start = index + 1;
  }
  const tail = text.slice(start).trim().replace(/[.!?。！？]$/u, "");
  if (tail) clauses.push(tail);
  return clauses;
}

/**
 * Preserve whole actions and declare only explicitly evidenced dependencies.
 * A conjunction or a path alone never creates an additional task.
 * @returns {{terms: string, laneHint: string, dependsOnIndexes: number[], dependencyEvidence: string, source: string}[]}
 */
export function decomposeTaskActions(task) {
  const text = String(task ?? "").trim();
  const clauses = explicitClauses(text).filter((clause) => !META_ONLY.test(clause) && !PARALLEL_ONLY.test(clause));
  const actions = [];
  for (const clause of clauses) {
    // Keep descriptive continuations with their action rather than manufacture
    // tasks from acceptance prose, object lists, or otherwise unknown fragments.
    if (actions.length && !ACTION_START.test(clause)) {
      actions[actions.length - 1].terms += `; ${clause}`;
      continue;
    }
    actions.push({ terms: clause, laneHint: clause.slice(0, 24), source: "explicit_action" });
  }
  const ordered = actions.some((action) => FIRST_STEP.test(action.terms) || LATER_STEP.test(action.terms));
  const assertions = dependencyAssertionText(text);
  const parallelDeclared = EXPLICIT_PARALLEL.test(assertions) && !NEGATIVE_PARALLEL.test(assertions) && !PARALLEL_FEASIBILITY.test(assertions) && !ordered && !RESULT_REFERENCE.test(assertions);
  return actions.map((action, index) => {
    const followsPrevious = index > 0 && LATER_STEP.test(action.terms);
    return {
      ...action,
      dependsOnIndexes: followsPrevious ? Array.from({ length: index }, (_, previous) => previous) : [],
      dependencyEvidence: followsPrevious
        ? "explicit_sequence"
        : index === 0 && ordered
          ? "explicit_sequence_start"
          : parallelDeclared
            ? "explicit_parallel_request"
            : "unproven",
    };
  });
}
