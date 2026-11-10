/** Display the saved preparation's next step without inventing work, choices,
 * native invocation or acceptance. The CLI emits this only when requested. */
const COPY = Object.freeze({
  "zh-CN": {
    title: "Meta_Kim 对话提示：需求和当前准备状态已保存。",
    stopped: "任务已暂停，等待你明确要求继续。",
    input: "下一步：当前助手会根据已有材料，提出会影响结果的具体问题或方案。",
    critical: "下一步：当前助手整理目标、现有条件与验收标准。",
    fetch: "下一步：当前助手补查会影响方案的资料与项目事实。",
    thinking: "下一步：当前助手结合已查资料，形成方案和对应任务。",
    boundary: "准备记录尚不代表已经执行或完成验收。",
  },
  en: {
    title: "Meta_Kim update: the request and current preparation state are saved.",
    stopped: "The task is paused until you explicitly ask to continue.",
    input: "Next: the current assistant will present the concrete questions or options that affect the outcome.",
    critical: "Next: the current assistant will establish the goal, existing conditions and acceptance criteria.",
    fetch: "Next: the current assistant will research the facts and sources that affect the plan.",
    thinking: "Next: the current assistant will use the gathered evidence to form the plan and tasks.",
    boundary: "Preparation is not evidence of execution or acceptance.",
  },
  "ja-JP": {
    title: "Meta_Kim の進捗：依頼と現在の準備状態を保存しました。",
    stopped: "タスクは停止中です。明示的な再開の指示を待ちます。",
    input: "次に、担当アシスタントが結果に影響する具体的な質問や選択肢を示します。",
    critical: "次に、担当アシスタントが目的、既存の条件、受け入れ基準を整理します。",
    fetch: "次に、担当アシスタントが計画に影響する資料とプロジェクトの事実を調査します。",
    thinking: "次に、担当アシスタントが調査結果を基に計画とタスクをまとめます。",
    boundary: "準備記録は実行や受け入れ完了の証拠ではありません。",
  },
  "ko-KR": {
    title: "Meta_Kim 진행 알림: 요청과 현재 준비 상태를 저장했습니다.",
    stopped: "작업이 일시 중지되었습니다. 명시적인 재개 요청을 기다립니다.",
    input: "다음 단계: 현재 어시스턴트가 결과에 영향을 주는 구체적인 질문이나 선택지를 제시합니다.",
    critical: "다음 단계: 현재 어시스턴트가 목표, 기존 조건, 검수 기준을 정리합니다.",
    fetch: "다음 단계: 현재 어시스턴트가 계획에 영향을 주는 자료와 프로젝트 사실을 조사합니다.",
    thinking: "다음 단계: 현재 어시스턴트가 조사한 근거로 계획과 작업을 구성합니다.",
    boundary: "준비 기록은 실행이나 검수 완료의 증거가 아닙니다.",
  },
});

export function renderPreparationNotice(report) {
  if (report?.artifactKind !== "host_preparation" || !report.hostInvocationRequestPacket?.nextAction) {
    throw new TypeError("A preparation notice requires a saved host preparation and next action");
  }
  const copy = COPY[report.resolvedOutputLanguage] ?? COPY.en;
  const action = report.hostInvocationRequestPacket.nextAction;
  const next = report.preparation.status === "stopped_by_user" ? copy.stopped
    : report.preparation.status === "needs_input" && action.stage !== "Fetch" ? copy.input
      : action.stage === "Critical" ? copy.critical
        : action.stage === "Fetch" ? copy.fetch : copy.thinking;
  return [copy.title, next, copy.boundary].join("\n");
}
