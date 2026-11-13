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
});

export function liveWorkspaceIcon(name) {
  return `<svg class="uw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.work}</svg>`;
}

export function renderLiveWorkspaceNavigation() {
  const nav = (id, label, icon) => `<button class="uw-nav-item" type="button" data-uw-view="${id}" data-live-workspace-nav="${id}" aria-current="${id === "work" ? "page" : "false"}">${liveWorkspaceIcon(icon)}<span data-uw-label="${id}">${label}</span><span class="uw-nav-count" data-uw-count="${id}" hidden></span></button>`;
  return `<aside class="uw-navigation" id="uw-navigation" data-uw-navigation aria-label="工作区导航">
    <div class="uw-nav-heading"><span data-uw-nav-heading-text>工作空间</span><button type="button" class="uw-icon-button uw-mobile-close" data-uw-nav-close aria-label="关闭导航">${liveWorkspaceIcon("close")}</button></div>
    <button class="uw-project-switch" type="button" data-uw-project-switch aria-label="选择项目与运行"><span class="uw-project-avatar" aria-hidden="true">K</span><span class="uw-project-copy"><strong data-uw-project-name>选择项目</strong><small data-uw-run-name>查看真实运行记录</small></span>${liveWorkspaceIcon("chevron")}</button>
    <nav class="uw-primary-nav" aria-label="主视图">${nav("work", "工作", "work")}${nav("prd", "PRD", "document")}${nav("records", "记录", "history")}${nav("graph", "运行图", "graph")}</nav>
    <div class="uw-nav-section-heading"><span data-uw-module-heading>系统模块</span><span data-uw-module-count>—</span></div>
    <div class="uw-module-nav" data-uw-modules aria-label="全部系统模块"><p class="uw-nav-empty">模块拆分后会出现在这里</p></div>
    <div class="uw-nav-footer"><button class="uw-nav-item" type="button" data-uw-view="repository">${liveWorkspaceIcon("layers")}<span data-uw-label="repository">项目资料</span></button><p data-uw-nav-footer>同一工作 · 持续接续</p></div>
  </aside>`;
}

export function renderLiveWorkspaceSurface() {
  return `<div class="uw-workspace" data-uw-workspace data-live-workspace-root data-workspace-revision="" data-view="work" data-detail-open="false">
    <header class="uw-overview">
      <div class="uw-overview-kicker"><span data-uw-origin hidden></span><span data-uw-project-label>Meta_Kim 工作空间</span></div>
      <h1 data-uw-title>让每一步都有去向</h1>
      <p class="uw-overview-subtitle" data-uw-next>选择已有项目，查看模块、产物和接续状态。</p>
      <div class="uw-overview-meta"><span class="uw-status" data-uw-status>等待运行记录</span><span data-uw-update></span></div>
    </header>
    <div class="uw-stage-strip" data-uw-stages role="list" aria-label="八阶段与当前状态"></div>
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
