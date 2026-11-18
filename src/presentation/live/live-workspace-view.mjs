/** Original Live workspace chrome. Runtime facts are rendered with text nodes. */
const ICONS = Object.freeze({
  work: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M8 9v11"/>',
  document: '<path d="M7 3h7l4 4v14H6V3h1ZM14 3v5h4M9 12h6M9 16h6"/>',
  history: '<path d="M3 11a9 9 0 1 1 2 7M3 5v6h6M12 7v5l3 2"/>',
  graph: '<rect x="8" y="2" width="8" height="5" rx="1"/><rect x="2" y="17" width="7" height="5" rx="1"/><rect x="15" y="17" width="7" height="5" rx="1"/><path d="M12 7v5H5v5M12 12h7v5"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5Zm-9 10 9 5 9-5M3 18l9 5 9-5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  refresh: '<path d="M20 6v5h-5M4 18v-5h5M5.5 8a7 7 0 0 1 11.6-3L20 8M4 16l2.9 3A7 7 0 0 0 18.5 16"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  sidebarLeft: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  maximize: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  restore: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  minimize: '<path d="M5 12h14"/>',
});

export function liveWorkspaceIcon(name) {
  return `<svg class="uw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.work}</svg>`;
}

export function renderLiveWorkspaceNavigation() {
  const nav = (id, label, icon) => `<button class="uw-nav-item" type="button" data-uw-view="${id}" data-live-workspace-nav="${id}" aria-current="${id === "work" ? "page" : "false"}">${liveWorkspaceIcon(icon)}<span data-uw-label="${id}">${label}</span><span class="uw-nav-count" data-uw-count="${id}" hidden></span></button>`;
  return `<aside class="uw-navigation" id="uw-navigation" data-uw-navigation aria-label="工作区导航">
    <div class="uw-nav-heading"><span data-uw-nav-heading-text>工作空间</span><div class="uw-nav-heading-actions"><button type="button" class="uw-icon-button uw-nav-collapse-btn" data-uw-nav-collapse title="收起侧边栏" aria-label="收起侧边栏">${liveWorkspaceIcon("sidebarLeft")}</button><button type="button" class="uw-icon-button uw-mobile-close" data-uw-nav-close aria-label="关闭导航">${liveWorkspaceIcon("close")}</button></div></div>
    <button class="uw-project-switch" type="button" data-uw-project-switch aria-label="选择仓库与运行"><span class="uw-project-avatar" aria-hidden="true">K</span><span class="uw-project-copy"><strong data-uw-project-name>选择仓库</strong><small data-uw-run-name>切换仓库与运行记录</small></span>${liveWorkspaceIcon("chevron")}</button>
    <nav class="uw-primary-nav" aria-label="主视图">${nav("work", "工作", "work")}${nav("prd", "PRD", "document")}${nav("repository", "仓库", "layers")}${nav("records", "记录", "history")}${nav("graph", "运行图", "graph")}</nav>
    <section class="uw-agent-inventory" data-uw-agent-inventory aria-label="Agent 协作与能力清单"></section>
    <div class="uw-nav-section-heading"><span data-uw-module-heading>系统模块</span><span data-uw-module-count>—</span></div>
    <div class="uw-module-nav" data-uw-modules aria-label="全部系统模块"><p class="uw-nav-empty">模块拆分后会出现在这里</p></div>
    <div class="uw-nav-footer"><p data-uw-nav-footer>同一工作 · 持续接续</p></div>
    <div class="uw-nav-resizer" data-uw-nav-resizer role="separator" aria-orientation="vertical" aria-label="拖拽调整侧边栏宽度" title="拖拽调整侧边栏宽度，双击重置"></div>
  </aside>`;
}

export function renderLiveWorkspaceSurface() {
  return `<div class="uw-workspace" data-uw-workspace data-live-workspace-root data-workspace-revision="" data-view="work" data-detail-open="false" data-pane-layout="split">
    <header class="uw-overview">
      <div class="uw-overview-kicker"><span data-uw-origin hidden></span><span data-uw-project-label>Meta_Kim 工作空间</span></div>
      <h1 data-uw-title>让每一步都有去向</h1>
      <p class="uw-overview-subtitle" data-uw-next>选择已有项目，查看模块、产物和接续状态。</p>
      <div class="uw-overview-meta"><span class="uw-status" data-uw-status>等待运行记录</span><span data-uw-update></span></div>
    </header>
    <section class="uw-agent-entry" data-uw-agent-entry aria-label="Meta_Kim Agent 对话">
      <div class="uw-agent-chat" data-uw-agent-chat>
        <header class="uw-agent-chat-header">
          <div class="uw-agent-chat-identity"><button type="button" class="uw-icon-button uw-nav-expand-btn" data-uw-nav-expand hidden title="展开侧边栏" aria-label="展开侧边栏">${liveWorkspaceIcon("sidebarLeft")}</button><span class="uw-agent-chat-emblem" aria-hidden="true">K</span><div><strong>Meta_Kim</strong><span>Agent 对话 · 关键节点由你决定</span></div></div>
          <div class="uw-pane-header-right">
            <button type="button" class="uw-binding-toggle-btn" data-uw-open-binding aria-expanded="false" title="正向调用或反向绑定外部 Agent 会话">双向绑定</button>
            <span class="uw-agent-chat-connection" data-uw-chat-connection>正在连接</span>
            <button type="button" class="uw-pane-restore-pill" data-uw-pane-restore-live hidden title="展开右侧 Live 画布" aria-label="展开右侧 Live 画布">展开画布</button>
            <button type="button" class="uw-icon-button uw-pane-btn" data-uw-pane-toggle="chat-max" title="最大化对话窗口" aria-label="最大化对话窗口">${liveWorkspaceIcon("maximize")}</button>
          </div>
        </header>
        <div class="uw-agent-chat-scope"><span class="uw-agent-chat-scope-dot" aria-hidden="true"></span><span>当前仓库</span><strong data-uw-chat-project>正在核对…</strong><button type="button" class="uw-chat-repo-switch-btn" data-uw-chat-switch-repo title="切换本地已登记仓库或历史运行">切换仓库 ▾</button></div>
        <section class="uw-binding-drawer" data-uw-binding-drawer hidden aria-label="双向 Agent 绑定与渠道中心"></section>
        <div class="uw-agent-chat-thread" data-uw-chat-thread role="log" aria-label="Agent 对话记录" aria-live="off"></div>
        <div class="uw-chat-announcement" data-uw-chat-announcement role="status" aria-live="polite" aria-atomic="true"></div>
        <div class="uw-agent-chat-target" data-uw-chat-target hidden><span data-uw-chat-target-text></span><button type="button" data-uw-chat-target-clear aria-label="取消关联节点">×</button></div>
        <form class="uw-agent-chat-composer" data-uw-chat-form autocomplete="off">
          <label class="uw-agent-chat-label" for="uw-chat-input">向 Meta_Kim 发送消息</label>
          <textarea id="uw-chat-input" data-uw-chat-input rows="2" maxlength="6000" placeholder="说说你想完成什么，或直接指出右侧节点的问题…"></textarea>
          <div class="uw-agent-chat-composer-bottom"><label class="uw-chat-channel-picker" for="uw-chat-host"><span class="uw-chat-channel-label">渠道</span><select id="uw-chat-host" class="uw-chat-host-select" data-uw-chat-host aria-label="选择 Agent 渠道"><option value="">检测渠道…</option></select></label><span data-uw-chat-guidance>Enter 发送，Shift+Enter 换行</span><button type="submit" data-uw-chat-send aria-label="发送消息" title="发送消息">${liveWorkspaceIcon("arrow")}</button></div>
        </form>
      </div>
      <div class="uw-agent-legacy" hidden>
      <form data-uw-agent-start autocomplete="off">
        <div class="uw-agent-entry-heading"><div><span class="uw-agent-entry-kicker">新任务研究草稿 · 尚未进入正式 Run</span><h2 id="uw-agent-entry-title">说出你想做的事</h2></div><a class="uw-agent-entry-path" href="#uw-user-flow">查看正式运行的五步进度</a></div>
        <div class="uw-agent-scope" role="note"><span>研究所属项目</span><strong data-uw-agent-scope>正在核对本地执行范围…</strong><small data-uw-agent-scope-note>左侧项目只用于查看记录；切换页面中的项目不会改变执行位置。</small></div>
        <label class="uw-agent-entry-goal-label" for="uw-agent-goal">任务描述</label>
        <textarea class="uw-agent-entry-goal" data-uw-agent-goal id="uw-agent-goal" rows="2" maxlength="6000" placeholder="比如：调查这项需求，提出 2—3 个真正不同的方案，比较依据、成本和风险，并说明推荐理由。" aria-describedby="uw-agent-entry-help"></textarea>
        <div class="uw-agent-entry-actions">
          <span class="uw-agent-entry-help" id="uw-agent-entry-help">先生成只读方案，采纳后仅记录设计意向；实际执行必须由受控运行接续。</span>
          <label class="uw-agent-entry-host-label" for="uw-agent-host">研究客户端<select class="uw-agent-entry-host" data-uw-agent-host id="uw-agent-host" disabled><option value="">正在检测…</option></select></label>
          <button class="uw-agent-entry-submit" data-uw-agent-submit type="submit" disabled>生成方案${liveWorkspaceIcon("arrow")}</button>
        </div>
        <details class="uw-agent-host-status" data-uw-agent-host-status hidden><summary>查看客户端连接情况</summary><ul data-uw-agent-host-list></ul></details>
        <div class="uw-agent-entry-status" data-uw-agent-status role="status" aria-live="polite" aria-atomic="true" hidden></div>
        <details class="uw-agent-entry-result" data-uw-agent-result hidden><summary><span data-uw-agent-result-summary>研究建议 · 等待你确认</span></summary><div class="uw-agent-options" data-uw-agent-options hidden></div><details class="uw-agent-entry-raw" data-uw-agent-raw open><summary>原始研究回执</summary><pre data-uw-agent-output></pre></details><p>这里展示客户端完整且符合服务端限制的只读方案。内容和依据仍待独立核验；未通过完整性校验的方案不能采纳。采纳、修改或放弃只写入决策回执。</p></details>
        <section class="uw-agent-decision" data-uw-agent-decision aria-labelledby="uw-agent-decision-title" hidden>
          <div class="uw-agent-decision-heading"><h3 id="uw-agent-decision-title">关键确认 · 方案怎么处理？</h3><span>人工选择</span></div>
          <p class="uw-agent-decision-note">请先核对方案与依据。出现结构化候选卡片时可以点选；如果返回普通文本，请手工写明所选方案。如缺少可比较的选择，请要求修改。采纳仅表示同意进入设计准备。</p>
          <div class="uw-agent-choice">
            <label for="uw-agent-strategy">我选择的方案 <span>采纳必填</span><input data-uw-agent-strategy id="uw-agent-strategy" maxlength="180" placeholder="例如：方案 B — 分阶段接入" /></label>
            <label for="uw-agent-choice-reason">选择理由 <span>采纳必填</span><textarea data-uw-agent-choice-reason id="uw-agent-choice-reason" rows="2" maxlength="1200" placeholder="为什么选择它？对应的限制和取舍是什么？"></textarea></label>
          </div>
          <label class="uw-agent-decision-feedback-label" for="uw-agent-feedback">修改要求（选择“要求修改”时必填）</label>
          <textarea class="uw-agent-decision-feedback" data-uw-agent-feedback id="uw-agent-feedback" rows="2" maxlength="2000" placeholder="说清楚哪些地方需要改、应补充哪些依据。"></textarea>
          <div class="uw-agent-decision-actions"><button type="button" class="uw-agent-adopt" data-uw-agent-adopt disabled>采纳用于设计</button><button type="button" data-uw-agent-revise disabled>要求修改</button><button type="button" data-uw-agent-reject disabled>放弃本方案</button></div>
          <p class="uw-agent-decision-receipt" data-uw-agent-decision-receipt role="status" aria-live="polite" hidden></p>
          <button type="button" class="uw-agent-decision-reconcile" data-uw-agent-decision-reconcile hidden>用原决策号安全重试</button>
        </section>
        <section class="uw-agent-design" data-uw-agent-design aria-labelledby="uw-agent-design-title" hidden>
          <div class="uw-agent-design-heading"><div><span>第二步 · B2 设计</span><h3 id="uw-agent-design-title">把采纳方案变成可审阅的设计</h3></div><button type="button" data-uw-agent-design-refresh>检查设计版本</button></div>
          <p class="uw-agent-design-status" data-uw-agent-design-status role="status" aria-live="polite">待生成／导入真实设计</p>
          <p class="uw-agent-design-note">系统级 PRD 和模块任务图会绑定你已采纳的方案。这里仅记录真实输入和人工确认；保存设计不会启动代码执行或发布。</p>
          <div class="uw-agent-draft" data-uw-agent-draft hidden>
            <p data-uw-agent-draft-status role="status" aria-live="polite">准备自动生成可修改的两级设计草稿…</p>
            <div class="uw-agent-draft-actions"><button type="button" data-uw-agent-draft-generate hidden>生成设计草稿（只读）</button><button type="button" data-uw-agent-draft-manual>改用手工填写</button><button type="button" data-uw-agent-draft-reconcile hidden>用原草稿号核对</button></div>
          </div>
          <div class="uw-agent-design-body" data-uw-agent-design-body></div>
        </section>
        <section class="uw-agent-transfer" data-uw-agent-transfer aria-labelledby="uw-agent-transfer-title" hidden>
          <div class="uw-agent-design-heading"><div><span>设计之后 · 正式任务预交接</span><h3 id="uw-agent-transfer-title">准备正式运行的交接材料</h3></div><button type="button" data-uw-agent-transfer-check>核对交接状态</button></div>
          <p class="uw-agent-design-status" data-uw-agent-transfer-status role="status" aria-live="polite">等待系统与模块设计全部人工批准。</p>
          <p class="uw-agent-design-note">交接只封存方案与设计的版本、摘要和批准证据。正式执行仍需受控客户端另行确认；这里不会自动启动 CLI、修改项目或创建 Run。</p>
          <div class="uw-agent-transfer-actions"><button type="button" data-uw-agent-transfer-prepare disabled hidden>准备交接材料（未执行）</button><button type="button" data-uw-agent-transfer-reconcile hidden>用原交接号安全重试</button></div>
          <div class="uw-agent-transfer-receipt" data-uw-agent-transfer-receipt hidden></div>
        </section>
        <section class="uw-agent-gate" data-uw-agent-execution aria-labelledby="uw-agent-execution-title" hidden>
          <div class="uw-agent-design-heading"><div><span>下一关 · 真实运行与 B3 权限</span><h3 id="uw-agent-execution-title">执行前，还要核验什么？</h3></div><button type="button" data-uw-agent-execution-records>查看正式 Run 记录</button></div>
          <p class="uw-agent-design-status" data-uw-agent-execution-status role="status">等待真实宿主、正式运行身份与必要的副作用授权。</p>
          <p class="uw-agent-design-note">B3 仅允许当前项目的一次本地草稿修改。原生客户端使用受限工具，禁止命令、对外发送、付款和发布；正式 Run、测试与 B4 验收仍需单独核对。</p>
          <div class="uw-agent-transfer-actions">
            <button type="button" data-uw-agent-execution-authorize hidden>批准 B3 并启动本地草稿</button>
            <button type="button" data-uw-agent-execution-check>检查原生任务状态</button>
          </div>
          <p class="uw-agent-design-status" data-uw-agent-execution-native role="status" aria-live="polite"></p>

          <ul class="uw-agent-gate-list" data-uw-agent-execution-evidence></ul>
          <p class="uw-agent-design-note">这里会清楚区分“设计批准”“交接封存”“宿主确认”“实际运行”和“敏感操作授权”。左侧选中的 Run 不会自动视作本任务的执行证据。</p>
        </section>
        <section class="uw-agent-gate" data-uw-agent-acceptance aria-labelledby="uw-agent-acceptance-title" hidden>
          <div class="uw-agent-design-heading"><div><span>最终关 · B4 用户验收</span><h3 id="uw-agent-acceptance-title">有证据后再交付</h3></div></div>
          <p class="uw-agent-design-status" data-uw-agent-acceptance-status role="status">尚无与本任务绑定的可验收成果。</p>
          <ul class="uw-agent-gate-list" data-uw-agent-acceptance-evidence></ul>
          <p class="uw-agent-design-note">在真实产物、测试、独立复核与最终用户选择都有可核验记录之前，不显示“已完成／已验收”。</p>
        </section>
        <div class="uw-agent-entry-recovery" data-uw-agent-recovery hidden><button type="button" data-uw-agent-verify>检查提交结果</button><button type="button" data-uw-agent-redetect>重新检测客户端</button><button type="button" data-uw-agent-new hidden>发起下一项</button></div>
      </form>
      </div>
    </section>
    <div class="uw-split-resizer" data-uw-split-resizer role="separator" aria-orientation="vertical" aria-label="拖拽调整对话与画布分栏宽度" title="拖拽调整分栏宽度，双击重置比例"></div>
    <section class="uw-agent-live" data-uw-agent-live aria-label="Meta_Kim Live 可视化画布">
      <header class="uw-agent-live-header">
        <div class="uw-agent-live-title"><span class="uw-agent-live-pulse" aria-hidden="true"></span><div><strong>Meta_Kim <span>LIVE</span></strong><small>工作过程 · 实时可视化</small></div></div>
        <span class="uw-agent-live-source" data-uw-live-source>等待数据</span>
      </header>
      <div class="uw-agent-live-bar">
        <div class="uw-agent-live-modes" role="tablist" aria-label="Live 可视化视图">
          <button type="button" class="uw-legacy-mode-tab" id="uw-live-tab-flow" data-uw-live-mode="flow" role="tab" aria-controls="uw-live-content" aria-selected="false">阶段进度</button>
          <button type="button" id="uw-live-tab-knowledge" data-uw-live-mode="knowledge" role="tab" aria-controls="uw-live-content" aria-selected="true">产品设计 PRD</button>
          <button type="button" class="uw-legacy-mode-tab" id="uw-live-tab-agents" data-uw-live-mode="agents" role="tab" aria-controls="uw-live-content" aria-selected="false">Agent 协作</button>
          <button type="button" id="uw-live-tab-live-run" data-uw-live-mode="live-run" role="tab" aria-controls="uw-live-content" aria-selected="false">完整运行图 · Subagents</button>
        </div>
        <div class="uw-pane-window-controls" role="group" aria-label="画布窗口控制">
          <button type="button" class="uw-pane-restore-pill" data-uw-pane-restore-chat hidden title="还原左右分栏" aria-label="还原左右分栏">还原分栏</button>
          <button type="button" class="uw-icon-button uw-pane-btn" data-uw-pane-toggle="live-min" title="最小化右侧画布" aria-label="最小化右侧画布">${liveWorkspaceIcon("minimize")}</button>
          <button type="button" class="uw-icon-button uw-pane-btn" data-uw-pane-toggle="live-max" title="最大化右侧画布" aria-label="最大化右侧画布">${liveWorkspaceIcon("maximize")}</button>
        </div>
      </div>
      <div class="uw-agent-live-viewport" id="uw-live-content" data-uw-live-viewport role="tabpanel" aria-labelledby="uw-live-tab-flow" aria-live="off"></div>
      <div class="uw-agent-docked-run-slot" data-uw-docked-run-slot hidden></div>
      <footer class="uw-agent-live-footer" data-uw-live-footer><span data-uw-live-caption>拖拽节点或分栏可自由布局；点击节点可在左侧反馈</span><span data-uw-live-count>0 个节点</span></footer>
    </section>
    <section class="uw-user-flow" id="uw-user-flow" data-uw-user-flow aria-label="已选正式运行的用户路径">
      <div class="uw-user-flow-heading"><strong>已选正式 Run · 五步治理进度</strong><span>仅显示左侧所选运行的真实阶段。上方研究草稿或采纳回执不会直接推进这里。</span></div>
      <ol class="uw-phase-strip" data-uw-phases aria-label="五步用户进度"></ol>
      <details class="uw-advanced-stages"><summary>展开 Meta 治理八阶段 · 查看原始状态和证据</summary><div class="uw-stage-strip" data-uw-stages role="list" aria-label="八阶段与当前状态"></div></details>
    </section>
    <div class="uw-notice" data-uw-notice role="status" hidden></div>
    <div class="uw-body">
      <section class="uw-primary" aria-labelledby="uw-view-title">
        <header class="uw-content-header"><div class="uw-heading-copy"><p class="uw-eyebrow" data-uw-eyebrow>当前运行</p><h2 id="uw-view-title" data-uw-view-title>工作</h2></div><div class="uw-content-actions"><span class="uw-data-state" data-uw-data-state></span><button class="uw-icon-button" type="button" data-uw-refresh aria-label="刷新当前工作">${liveWorkspaceIcon("refresh")}</button></div></header>
        <div class="uw-toolbar" data-uw-toolbar></div>
        <div class="uw-main-content" data-uw-content tabindex="-1"></div>
        <footer class="uw-content-footer" data-uw-footer></footer>
      </section>
      <aside class="uw-detail" data-uw-detail aria-labelledby="uw-detail-title" hidden>
        <header class="uw-detail-header"><div class="uw-heading-copy"><p class="uw-eyebrow" data-uw-detail-kind>当前任务</p><h2 id="uw-detail-title" data-uw-detail-title>详情</h2></div><button class="uw-icon-button" type="button" data-uw-detail-close data-live-workspace-detail-close aria-label="关闭详情并返回列表">${liveWorkspaceIcon("close")}</button></header>
        <div class="uw-detail-body" data-uw-detail-body></div>
      </aside>
    </div>
    <footer class="uw-workspace-footer"><span data-uw-source>结果以实际记录与验证为准</span><span data-uw-read-state></span></footer>
  </div>`;
}

export function renderLiveWorkspaceMobileToggle() {
  return `<button class="topbar-button uw-navigation-toggle" type="button" data-uw-nav-open aria-label="打开工作区导航" aria-controls="uw-navigation" aria-expanded="false">${liveWorkspaceIcon("menu")}</button>`;
}
