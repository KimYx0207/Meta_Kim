/** Localized explanations; runtime selection rules remain in config/contracts. */
export const architectureCopy = {
  'zh-CN': {
    title: '应用、数据和展示，各自负责',
    sub: '沿着一次任务，看配置、执行、记录和界面怎样连接',
    source: ['方法与配置：各有唯一权威', ['canonical/ 保存共享方法', 'config/ 保存阶段、策略与适配契约']],
    application: ['应用编排层', ['解析目标、组织八阶段与任务依赖', '保存恢复点，汇总实际执行与核验结果']],
    data: ['数据层', ['运行、证据与事项引用', '保存当前状态与历史', '支撑恢复和结果核对']],
    adapter: ['宿主适配层', ['按已验证能力执行', '宿主提供模型和工具', '把真实结果返回编排层']],
    presentation: ['展示层', ['Live、运行视图与 README 呈现状态和依据', '界面读取结果，选择规则仍来自配置']],
    result: '执行结果返回',
    footer: '共享方法不在客户端重复维护；展示不另写一套业务规则。',
  },
  en: {
    title: 'Application, data and presentation',
    sub: 'Follow one task through configuration, execution, records and UI',
    source: ['One authority for each fact', ['canonical/ holds shared methods', 'config/ holds rules, policies and adapters']],
    application: ['Application orchestration', ['Interpret goals and organize task dependencies', 'Run the eight stages; keep recovery and review evidence']],
    data: ['Data layer', ['Runs and evidence', 'Current and past state', 'Recovery and checks']],
    adapter: ['Host adapters', ['Verified capabilities', 'Host model and tools', 'Actual results return']],
    presentation: ['Presentation layer', ['Live, run views and README show state and evidence', 'Views read results; policy stays in configuration']],
    result: 'Results return',
    footer: 'Shared methods stay in one source. Views do not duplicate business policy.',
  },
  'ja-JP': {
    title: 'アプリ、データ、表示の責任を分ける',
    sub: '一つの依頼で、設定・実行・記録・画面をつなぐ',
    source: ['事実の種類ごとに、正本を一つにする', ['canonical/ に共通の方法を保存', 'config/ に段階・方針・連携の契約を保存']],
    application: ['アプリケーション層', ['目標、八つの段階、作業の依存関係を整理', '再開点を残し、実行と検証の結果を集約']],
    data: ['データ層', ['実行・証拠・案件参照', '現在と過去を保存', '再開と結果確認の根拠']],
    adapter: ['ホスト連携層', ['検証済み能力で実行', 'モデル・道具はホスト', '実際の結果を上の層へ']],
    presentation: ['表示層', ['Live・実行画面・README が状態と根拠を表示', '結果を読み、選択方針は設定に置く']],
    result: '実行結果を返す',
    footer: '共通の方法は一か所で管理。表示層は結果を読み取る。',
  },
  'ko-KR': {
    title: '앱, 데이터, 화면의 책임을 나누기',
    sub: '한 작업을 따라 설정, 실행, 기록, 화면의 연결을 확인합니다',
    source: ['각 정보에 하나의 기준 원본', ['canonical/ 에 공통 방법 보관', 'config/ 에 단계, 정책, 어댑터 계약 보관']],
    application: ['애플리케이션 계층', ['목표, 여덟 단계, 작업 의존 관계를 정리', '재개 지점을 저장하고 실행·검증 결과를 수집']],
    data: ['데이터 계층', ['실행·증거·업무 참조', '현재와 이전 기록 보관', '재개와 결과 확인 지원']],
    adapter: ['호스트 어댑터', ['검증된 기능으로 실행', '모델과 도구는 호스트 제공', '실제 결과를 위 계층에 반환']],
    presentation: ['표현 계층', ['Live, 실행 화면, README 에 상태와 근거 표시', '결과를 읽으며 선택 정책은 설정에서 관리']],
    result: '실행 결과 반환',
    footer: '공통 방법은 한 원본에서 관리하고 화면에 업무 규칙을 중복하지 않습니다.',
  },
};

export const runtimeSelectionCopy = {
  'zh-CN': {
    title: '客户端和模型，分别按本次任务选择',
    sub: '读配置与宿主信号 → 核对真实能力 → 执行 → 留下依据',
    task: ['任务输入与当前宿主', ['本轮可以显式指定客户端和模型', '默认值可追溯；模型名不等于客户端身份']],
    choices: [
      ['选择执行客户端', ['显式选择优先', '自动模式读取宿主信号', '兼容默认值来自配置']],
      ['确定模型请求', ['使用本轮模型配置', '缺省交给运行环境处理', '不在方法中锁定型号']],
    ],
    checks: [
      ['核对执行能力', ['安装发现只是线索', '还要核对适配与权限', '未验证支持保持未知']],
      ['由适配器应用', ['按实际协议传入模型', '不支持的请求明确报错', '不暗中替换用户选择']],
    ],
    receipt: ['执行后分别记录', ['请求的模型 · 已传入的模型 · 实际观察到的模型', '没有实际观测证据，就保留 unknown']],
    footer: '同一套方法可随客户端使用；实际支持以本轮证据为准。',
  },
  en: {
    title: 'Choose the client and model separately',
    sub: 'Configuration + host signals → capability checks → execution → evidence',
    task: ['Task inputs and current host', ['Select a client and model explicitly or use a traceable default', 'A model name does not identify the client']],
    choices: [
      ['Choose a client', ['Explicit choice first', 'Read host signals', 'Use configured default']],
      ['Request a model', ['Use run settings', 'Or runtime defaults', 'Methods stay portable']],
    ],
    checks: [
      ['Check capability', ['Find installed tools', 'Check access + adapter', 'Unknown if unverified']],
      ['Use the adapter', ['Pass the model ID', 'Reject missing support', 'Keep the user choice']],
    ],
    receipt: ['Record separate observations', ['Requested model · passed to adapter · observed model', 'No observation: keep unknown']],
    footer: 'Portable methods. Real capabilities need evidence.',
  },
  'ja-JP': {
    title: 'クライアントとモデルを別々に選ぶ',
    sub: '設定とホスト情報 → 能力の確認 → 実行 → 根拠を記録',
    task: ['依頼の入力と現在のホスト', ['クライアントとモデルを指定', '省略時の既定値も出所を記録', 'モデル名からクライアントを推測しない']],
    choices: [
      ['クライアントを選択', ['明示指定を優先', '自動はホスト情報から', '既定値は設定から']],
      ['モデルの要求を決定', ['今回の設定を使用', '省略時は環境に委任', '型番を方法に固定せず']],
    ],
    checks: [
      ['実行能力を確認', ['導入済みは手掛かり', '連携と権限も確認', '未検証は不明のまま']],
      ['連携機能で適用', ['仕様に沿って適用', '未対応は明示する', '指定を勝手に変えない']],
    ],
    receipt: ['実行後、別々に記録する', ['要求・適用・実測のモデルを区別して記録', '観測の証拠がなければ unknown を保持']],
    footer: '同じ方法を別のクライアントへ。実行可能かは対応と証拠で判断する。',
  },
  'ko-KR': {
    title: '클라이언트와 모델을 따로 선택하기',
    sub: '설정과 호스트 신호 → 실제 기능 확인 → 실행 → 근거 기록',
    task: ['작업 입력과 현재 호스트', ['클라이언트와 모델을 직접 지정', '생략한 경우 기본값의 출처를 기록', '모델 이름으로 클라이언트를 추측하지 않음']],
    choices: [
      ['클라이언트 선택', ['명시한 선택 우선', '호스트로 자동 선택', '기본값은 설정에서']],
      ['모델 요청 결정', ['실행 설정을 적용', '없으면 환경에 위임', '모델 고정 없음']],
    ],
    checks: [
      ['실행 기능 확인', ['설치는 단서일 뿐', '어댑터·권한 확인', '미검증은 미확인']],
      ['어댑터를 통해 적용', ['규약에 맞춰 전달', '미지원 요청 알림', '선택을 바꾸지 않음']],
    ],
    receipt: ['실행 후 각각 기록', ['요청한 모델 · 전달한 모델 · 실제 관측한 모델', '실제 관측 증거가 없으면 unknown 유지']],
    footer: '클라이언트가 바뀌어도 같은 방법을 사용하며 실제 기능은 증거로 확인합니다.',
  },
};
