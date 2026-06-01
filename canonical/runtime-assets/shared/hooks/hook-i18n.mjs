/**
 * Hook-specific i18n module for Meta_Kim hooks
 * Follows the same pattern as scripts/meta-kim-i18n.mjs
 */

import { platform } from "node:os";

// ── Detect language ──────────────────────────────────────────

/** Align with setup.mjs LANG_ARG_ALIASES so `--lang zh` resolves to zh-CN. */
const LANG_ALIASES = { zh: "zh-CN", ja: "ja-JP", ko: "ko-KR" };

function normalizeLangCode(code) {
  if (!code) return "en";
  const trimmed = String(code).trim();
  const lower = trimmed.toLowerCase();
  return LANG_ALIASES[lower] || trimmed;
}

function detectLang() {
  const envLang = process.env.META_KIM_LANG;
  if (envLang) return normalizeLangCode(envLang);
  // Heuristic: Windows with CJK system → Chinese
  if (platform() === "win32") {
    try {
      const sysLocale = Intl.DateTimeFormat().resolvedOptions().locale;
      if (/^zh/i.test(sysLocale)) return "zh-CN";
      if (/^ja/i.test(sysLocale)) return "ja-JP";
      if (/^ko/i.test(sysLocale)) return "ko-KR";
    } catch {
      // fall through
    }
  }
  return "en";
}

// ── Strings ───────────────────────────────────────────────────

const STRINGS = {
  en: {
    hookSkipTitle: "[Meta_Kim Hook Skip]",
    hookLabel: "Hook:",
    reasonLabel: "Reason:",
    impactLabel: "Impact:",
    restoreLabel: "Restore:",
    restoreInstructions: "Set META_KIM_HOOK_SKIP=empty",
    // Skip reasons
    skipReasonEnvVar: "META_KIM_HOOK_SKIP environment variable set",
    skipReasonKeyword: "Prompt indicates simple/query task",
    skipReasonGovernanceFlow: (detail) => `Governance flow: ${detail}`,
    skipReasonUnknown: (source) => `Unknown reason: ${source}`,
    // Hook impacts
    impactEnforceAgentDispatch:
      "Meta-theory dispatch enforcement bypassed; direct execution possible",
    impactPostFormat:
      "Code formatting not auto-applied; style inconsistencies possible",
    impactPostTypecheck: "Type checking skipped; type errors may reach runtime",
    impactStopConsoleLogAudit:
      "Console.log statements not flagged at session end",
    impactStopSaveProgress: "Progress not auto-saved; manual save required",
    impactStopMemorySave: "Session summary not written to MCP Memory",
    impactGeneric: "Hook behavior disabled",
  },
  "zh-CN": {
    hookSkipTitle: "[Meta_Kim Hook Skip]",
    hookLabel: "钩子:",
    reasonLabel: "原因:",
    impactLabel: "影响:",
    restoreLabel: "恢复:",
    restoreInstructions: "设置 META_KIM_HOOK_SKIP=empty",
    // Skip reasons
    skipReasonEnvVar: "已设置 META_KIM_HOOK_SKIP 环境变量",
    skipReasonKeyword: "提示词表示简单/查询任务",
    skipReasonGovernanceFlow: (detail) => `治理流程: ${detail}`,
    skipReasonUnknown: (source) => `未知原因: ${source}`,
    // Hook impacts
    impactEnforceAgentDispatch: "绕过了元理论调度执行；直接执行可能发生",
    impactPostFormat: "未自动应用代码格式；可能出现样式不一致",
    impactPostTypecheck: "跳过类型检查；类型错误可能到达运行时",
    impactStopConsoleLogAudit: "会话结束时未标记 console.log 语句",
    impactStopSaveProgress: "未自动保存进度；需要手动保存",
    impactStopMemorySave: "会话摘要未写入 MCP Memory",
    impactGeneric: "钩子行为已禁用",
  },
  "ja-JP": {
    hookSkipTitle: "[Meta_Kim Hook Skip]",
    hookLabel: "フック:",
    reasonLabel: "理由:",
    impactLabel: "影響:",
    restoreLabel: "復元:",
    restoreInstructions: "META_KIM_HOOK_SKIP=empty を設定します",
    // Skip reasons
    skipReasonEnvVar: "META_KIM_HOOK_SKIP 環境変数が設定されました",
    skipReasonKeyword: "プロンプトがシンプル/クエリタスクを示しています",
    skipReasonGovernanceFlow: (detail) => `ガバナンスフロー: ${detail}`,
    skipReasonUnknown: (source) => `未知の理由: ${source}`,
    // Hook impacts
    impactEnforceAgentDispatch:
      "メタ理論ディスパッチ強制がバイパスされました; 直接実行可能",
    impactPostFormat:
      "コードフォーマットが自動適用されません; スタイルの不一致が発生する可能性があります",
    impactPostTypecheck:
      "型チェックがスキップされました; 型エラーが実行時まで到達する可能性があります",
    impactStopConsoleLogAudit:
      "セッション終了時に console.log ステートメントがフラグされません",
    impactStopSaveProgress: "進行状況が自動保存されません; 手動保存が必要です",
    impactStopMemorySave: "セッションサマリーが MCP Memory に書き込まれません",
    impactGeneric: "フック動作が無効になっています",
  },
  "ko-KR": {
    hookSkipTitle: "[Meta_Kim Hook Skip]",
    hookLabel: "후크:",
    reasonLabel: "이유:",
    impactLabel: "영향:",
    restoreLabel: "복원:",
    restoreInstructions: "META_KIM_HOOK_SKIP=empty을 설정합니다",
    // Skip reasons
    skipReasonEnvVar: "META_KIM_HOOK_SKIP 환경변수가 설정됨",
    skipReasonKeyword: "프롬프트가 심플/쿼리 작업을 나타냄",
    skipReasonGovernanceFlow: (detail) => `거버넌스 흐름: ${detail}`,
    skipReasonUnknown: (source) => `알 수 없는 이유: ${source}`,
    // Hook impacts
    impactEnforceAgentDispatch: "메타이론 디스패치 강제 우회됨; 직접 실행 가능",
    impactPostFormat: "코드 포맷팅이 자동 적용되지 않음; 스타일 불일치 가능",
    impactPostTypecheck:
      "타입 검사 건너뜀; 타입 오류가 런타임까지 도달할 수 있음",
    impactStopConsoleLogAudit: "세션 종료時に console.log 문이 플래그되지 않음",
    impactStopSaveProgress: "진행 상황이 자동 저장되지 않음; 수동 저장 필요",
    impactStopMemorySave: "세션 요약이 MCP Memory에 기록되지 않음",
    impactGeneric: "후크 동작이 비활성화됨",
  },
};

const LANG = detectLang();
const t = STRINGS[LANG] || STRINGS.en;

export { t, LANG };
