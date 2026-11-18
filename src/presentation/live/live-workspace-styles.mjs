/** Workspace geometry stays local; spacing, type and leading use the shared Live scales. */
export const LIVE_WORKSPACE_CSS = String.raw`
:root { --uw-nav-width: 176px; --uw-detail-width: 352px; --uw-bg: #050505; --uw-surface: #101010; --uw-raised: #191919; --uw-border: #303237; --uw-soft: #23252a; --uw-ink: #f0f2f5; --uw-muted: #a8abb2; --uw-accent: #e1e4e9; --uw-accent-soft: rgba(225,228,233,.09); --uw-node-stroke: #af9165; --uw-running: #e8c582; --uw-running-glow: rgba(232,197,130,.3); --uw-graph-dependency: #8a909a; --uw-warm: #e5aa89; --uw-radius: 10px; --uw-page-gap: var(--sp-roomy); }
.shell[data-unified-workspace="true"] { --accent: var(--uw-accent); --running: var(--uw-running); --completion: #a5a9ae; --completion-bright: #d8dce1; --line: var(--uw-border); --line-soft: var(--uw-soft); grid-template-columns: var(--uw-nav-width) minmax(0, 1fr); grid-template-rows: 56px minmax(0,1fr); background: var(--uw-bg); }
.shell[data-unified-workspace="true"] > .topbar { grid-column: 1 / -1; padding-inline: var(--uw-page-gap); gap: var(--sp-roomy); border-bottom-color: var(--uw-border); background: #090909; }
.shell[data-unified-workspace="true"] .brand-mark { filter: brightness(0) saturate(100%) invert(88%); }
.shell[data-unified-workspace="true"] .topbar-button:hover, .shell[data-unified-workspace="true"] .topbar-button:focus-visible { border-color: #6c717a; background: var(--uw-accent-soft); color: var(--uw-accent); }
.shell[data-unified-workspace="true"]:not([data-nav-collapsed="true"]) .topbar-actions > [data-live-open-sessions] { display: none; }
.uw-top-flow-ribbon { display: none; }
.shell[data-unified-workspace="true"][data-work-view="workspace"]:has(> .uw-top-flow-ribbon:not(:empty)) { grid-template-rows: 52px 40px minmax(0,1fr); }
.shell[data-unified-workspace="true"][data-work-view="workspace"]:has(> .uw-top-flow-ribbon:not(:empty)) > .uw-top-flow-ribbon { grid-column: 1 / -1; grid-row: 2; display: flex; align-items: center; gap: var(--sp-cozy); min-height: 40px; padding: var(--sp-tight) var(--uw-page-gap); border-bottom: 1px solid #1f2634; background: linear-gradient(90deg,#0d121c,#090c13); overflow-x: auto; scrollbar-width: none; }
.shell[data-unified-workspace="true"][data-work-view="workspace"]:has(> .uw-top-flow-ribbon:not(:empty)) > .uw-navigation { grid-row: 3; }
.shell[data-unified-workspace="true"][data-work-view="workspace"]:has(> .uw-top-flow-ribbon:not(:empty)) > .main { grid-row: 3; }
.shell[data-unified-workspace="true"][data-work-view="workspace"]:has(> .uw-top-flow-ribbon:not(:empty)) .uw-agent-inventory-flyout { top: 92px; }
.shell:has([data-uw-top-flow]:not(:empty)) .uw-legacy-mode-tab { display: none !important; }
.uw-agent-docked-run-slot .stage-overview { display: none !important; }
.uw-top-flow-kicker { flex: 0 0 auto; line-height: var(--lh-flat); padding: var(--sp-tight) var(--sp-cozy); border-radius: 6px; background: #1c2230; color: #dec187; font-size: var(--fs-micro); font-weight: var(--weight-semibold); white-space: nowrap; }
.uw-top-flow-list { flex: 1 1 auto; min-width: 0; list-style: none; margin: 0; padding: 0; display: flex; align-items: center; gap: var(--sp-snug); }
.uw-top-flow-item { display: inline-flex; align-items: center; gap: var(--sp-snug); flex: 1 1 0; min-width: 0; }
.uw-top-flow-item:not(:last-child)::after { content: "→"; flex: 0 0 auto; color: #546075; font-size: var(--fs-micro); line-height: var(--lh-flat); }
.uw-agent-flow-node.uw-top-flow-step { line-height: var(--lh-flat); flex: 1 1 auto; min-width: 0; min-height: 28px; height: 28px; padding: var(--sp-tight) var(--sp-cozy); gap: var(--sp-snug); border-radius: 7px; border: 1px solid #262f42; background: #121722; box-shadow: none; }
.uw-agent-flow-node.uw-top-flow-step:hover, .uw-agent-flow-node.uw-top-flow-step[data-selected="true"] { border-color: #c8a96e; background: #221e16; box-shadow: none; }
.uw-agent-flow-node.uw-top-flow-step[data-state="completed"] { border-color: #2c6651; background: #10211c; }
.uw-agent-flow-node.uw-top-flow-step[data-state="waiting_human"] { border-color: #d49b4b; background: #261e12; }
.uw-top-flow-num { flex: 0 0 auto; color: #d6ba82; font-size: var(--fs-micro); font-variant-numeric: tabular-nums; font-weight: var(--weight-semibold); }
.uw-top-flow-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-micro); font-weight: var(--weight-semibold); color: #e8edf5; }
.uw-top-flow-state { flex: 0 0 auto; font-size: var(--fs-micro); color: #8f9bb0; white-space: nowrap; }
.uw-agent-flow-node.uw-top-flow-step[data-state="completed"] .uw-top-flow-state { color: #6ee7b7; }
.uw-agent-flow-node.uw-top-flow-step[data-state="running"] .uw-top-flow-state { color: #f4d695; }
.uw-agent-flow-node.uw-top-flow-step[data-state="waiting_human"] .uw-top-flow-state { color: #f6c177; }
.uw-top-flow-graph-btn { flex: 0 0 auto; line-height: var(--lh-flat); min-height: 28px; padding: var(--sp-tight) var(--sp-cozy); border: 1px solid #6e5c3d; border-radius: 7px; background: #231e15; color: #f2daa4; font: inherit; font-size: var(--fs-micro); font-weight: var(--weight-semibold); cursor: pointer; white-space: nowrap; }
.uw-top-flow-graph-btn:hover, .uw-top-flow-graph-btn[aria-pressed="true"] { border-color: #dec082; background: #30281b; color: #fff2d4; }
.shell[data-unified-workspace="true"] > .main { grid-column: 2; grid-row: 2; min-height: 0; }
.shell[data-work-view="workspace"] > .main, .shell[data-unified-workspace="true"][data-work-view="repository"] > .main { display: block; }
.shell[data-work-view="workspace"] .main > .run-context, .shell[data-work-view="workspace"] .main > .run-overview, .shell[data-unified-workspace="true"][data-work-view="repository"] .main > .run-context, .shell[data-unified-workspace="true"][data-work-view="repository"] .main > .run-overview { display: none; }
.shell[data-work-view="workspace"] .workspace-grid { height: 100%; display: block; padding: 0; background: var(--uw-bg); }
.shell[data-unified-workspace="true"][data-work-view="repository"] .workspace-grid { height: 100%; padding: 0; }
.shell[data-work-view="workspace"] .workspace-view { height: 100%; padding: 0; overflow: hidden; background: transparent; border: 0; }
.shell[data-unified-workspace="true"] .work-view-menu { display: none; }
.uw-icon { width: 18px; height: 18px; flex: 0 0 auto; }
.uw-icon-button { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 32px; min-width: 32px; height: 32px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--uw-muted); cursor: pointer; }
.uw-icon-button:hover { color: var(--uw-ink); background: var(--uw-raised); border-color: var(--uw-border); }
.uw-navigation { position: relative; grid-column: 1; grid-row: 2; display: flex; flex-direction: column; min-height: 0; min-width: 0; padding: var(--sp-cozy) var(--sp-cozy) var(--sp-default); border-right: 1px solid var(--uw-border); background: linear-gradient(180deg,#101010,#080808 74%); }
.uw-nav-heading { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-snug); padding-inline: var(--sp-cozy); color: var(--uw-muted); font-size: var(--fs-micro); letter-spacing: 0; }
.uw-nav-heading-actions { display: inline-flex; align-items: center; gap: var(--sp-snug); }
.uw-nav-resizer { position: absolute; top: 0; right: 0; bottom: 0; width: 5px; cursor: col-resize; z-index: 15; transition: background .15s ease; }
.uw-nav-resizer:hover, .uw-nav-resizer[data-dragging="true"] { background: #c8a96e88; }
.shell[data-unified-workspace="true"][data-nav-collapsed="true"] { grid-template-columns: 0 minmax(0,1fr) !important; }
.shell[data-unified-workspace="true"][data-nav-collapsed="true"] > .uw-navigation { display: none !important; }
.shell:has(.uw-workspace[data-agent-entry-enabled="true"]) .uw-nav-footer > p { display: none; }
.uw-project-switch { display: flex; align-items: center; gap: var(--sp-cozy); padding: var(--sp-cozy); margin: var(--sp-snug) 0 var(--sp-cozy); min-width: 0; width: 100%; background: #13151a; border: 1px solid #262a33; border-radius: var(--uw-radius); text-align: left; cursor: pointer; }
.uw-project-switch:hover { border-color: #6b7280; background: #191c23; }
.uw-project-avatar { display: grid; place-items: center; width: 28px; height: 28px; flex: 0 0 auto; border: 1px solid #4d5056; border-radius: 8px; color: var(--uw-ink); background: #222428; font-size: var(--fs-label); font-weight: var(--weight-semibold); }
.uw-project-copy { min-width: 0; flex: 1; display: grid; gap: var(--sp-snug); }
.uw-project-copy strong, .uw-project-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uw-project-copy strong { color: var(--uw-ink); font-size: var(--fs-label); }.uw-project-copy small { color: var(--uw-muted); font-size: var(--fs-micro); }
.uw-primary-nav { display: grid; gap: var(--sp-snug); }
.uw-nav-item { line-height: var(--lh-flat); width: 100%; display: flex; align-items: center; gap: var(--sp-cozy); min-height: 36px; padding: var(--sp-snug) var(--sp-cozy); border: 1px solid transparent; border-radius: 8px; color: var(--uw-muted); background: transparent; text-align: left; font-size: var(--fs-label); cursor: pointer; }
.uw-nav-item:hover { color: var(--uw-ink); background: #202227; }.uw-nav-item[aria-current="page"] { color: var(--uw-ink); background: #222428; border-color: #53575f; box-shadow: inset 2px 0 0 #c8cbd0; }
.uw-nav-count { line-height: var(--lh-flat); margin-left: auto; min-width: 20px; padding: var(--sp-hairline) var(--sp-snug); border-radius: 5px; background: #36383e; color: #d6d9de; font-size: var(--fs-micro); text-align: center; }
.uw-nav-section-heading { display: flex; justify-content: space-between; padding: var(--sp-band) var(--sp-default) var(--sp-default); font-size: var(--fs-micro); color: #989ca4; }
.uw-module-nav { overflow: auto; min-height: 0; flex: 1; scrollbar-width: thin; }
.uw-module-nav button { display: flex; gap: var(--sp-cozy); align-items: center; width: 100%; min-height: 38px; border: 0; border-radius: 7px; padding: var(--sp-cozy) var(--sp-default); background: transparent; color: var(--uw-muted); text-align: left; font-size: var(--fs-label); cursor: pointer; }
.uw-module-nav button::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: #747981; flex: 0 0 auto; }
.uw-module-nav button[data-selected="true"] { color: var(--uw-ink); background: #25272c; }.uw-module-nav button[data-selected="true"]::before { background: #d6d9de; }
.uw-module-nav button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.uw-nav-empty { margin: var(--sp-tight) var(--sp-default); font-size: var(--fs-label); color: #999da6; line-height: var(--lh-normal); }
.uw-nav-footer { margin-top: var(--sp-roomy); border-top: 1px solid var(--uw-soft); padding-top: var(--sp-default); }.uw-nav-footer p { margin: var(--sp-roomy) 0 0; text-align: center; color: #999da6; font-size: var(--fs-micro); }
.uw-navigation-toggle, .uw-mobile-close { display: none; }
.uw-workspace { height: 100%; min-height: 0; display: grid; grid-template-rows: max-content max-content max-content max-content minmax(0,1fr) max-content; overflow: hidden; color: var(--uw-ink); background: radial-gradient(ellipse 70% 40% at 40% -10%,#43474e14,transparent 70%),var(--uw-bg); }
/* Explicit tracks preserve the body row even when the optional intake and notice are hidden. */
.uw-workspace > .uw-overview { grid-row: 1; }
.uw-workspace > .uw-agent-entry { grid-row: 2; }
.uw-workspace > .uw-user-flow { grid-row: 3; }
.uw-workspace > .uw-notice { grid-row: 4; }
.uw-workspace > .uw-body { grid-row: 5; }
.uw-workspace > .uw-workspace-footer { grid-row: 6; }
.uw-workspace:not([data-agent-entry-enabled="true"]), .uw-workspace[data-view="prd"], .uw-workspace[data-view="records"] { grid-template-rows: max-content 0 max-content max-content minmax(0,1fr) max-content; }
.uw-workspace[data-agent-entry-enabled="true"][data-view="work"] { grid-template-rows: max-content max-content max-content max-content minmax(380px,1fr) max-content; overflow-y: auto; }
.uw-overview { position: relative; isolation: isolate; display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: var(--sp-cozy) var(--sp-default); padding: var(--sp-default) var(--uw-page-gap) var(--sp-cozy); min-width: 0; overflow: hidden; text-align: left; }
.uw-overview::before { position: absolute; z-index: -1; inset: -125% 32% -130% -10%; content: ""; pointer-events: none; background: radial-gradient(ellipse at center,rgba(98,106,116,.07),transparent 65%); transform: translateX(-8%); animation: uw-atmosphere 16s ease-in-out infinite alternate; }
.uw-overview-kicker { grid-column: 1; display: flex; justify-content: flex-start; align-items: center; flex-wrap: wrap; gap: var(--sp-cozy); color: var(--uw-muted); font-size: var(--fs-micro); }
.shell[data-work-view="workspace"] .uw-overview h1 { grid-column: 1; max-width: 100%; margin: var(--sp-cozy) 0 0; font-size: var(--fs-hero); line-height: var(--lh-snug); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.uw-overview-subtitle { grid-column: 1; max-width: min(78ch,100%); margin: 0; color: var(--uw-muted); font-size: var(--fs-label); line-height: var(--lh-normal); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.uw-overview-meta span { min-width: 0; overflow-wrap: anywhere; }
.uw-overview-meta { grid-column: 2; grid-row: 1 / 4; display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: var(--sp-default); min-height: 24px; margin: 0; font-size: var(--fs-micro); color: #a9adb5; }
.uw-status { display: inline-flex; align-items: center; gap: var(--sp-snug); color: var(--uw-muted); }.uw-status::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
[data-uw-origin]:not([hidden]) { padding: var(--sp-hairline) var(--sp-cozy); border: 1px solid #50535a; border-radius: 4px; color: var(--uw-muted); background: #222429; }
.uw-agent-entry { margin: 0 var(--uw-page-gap) var(--sp-default); padding: var(--sp-default) var(--sp-roomy); min-width: 0; border: 1px solid #45464a; border-radius: var(--uw-radius); background: linear-gradient(112deg,#171717 0%,#0e0e0e 72%); box-shadow: 0 12px 32px #0003; }
.uw-workspace[data-view="prd"] .uw-agent-entry, .uw-workspace[data-view="records"] .uw-agent-entry, .uw-workspace[data-view="prd"] .uw-user-flow, .uw-workspace[data-view="prd"] .uw-overview { display: none; }
.uw-agent-entry form { display: grid; gap: var(--sp-cozy); min-width: 0; }
.uw-agent-entry-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--sp-default); }
.uw-agent-entry-kicker { display: block; color: #adb0b6; font-size: var(--fs-micro); line-height: var(--lh-normal); }
.uw-agent-entry-heading h2 { margin: 0; font-size: var(--fs-entity-body); line-height: var(--lh-normal); color: var(--uw-ink); }
.uw-agent-entry-path { color: #c9cdd5; font-size: var(--fs-micro); line-height: var(--lh-normal); text-underline-offset: 3px; }
.uw-agent-entry-path:focus-visible { outline: 2px solid #e1e4e9; outline-offset: 2px; }
.uw-agent-scope { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--sp-cozy); padding: var(--sp-cozy) var(--sp-default); border: 1px solid #393c43; border-radius: 7px; background: #111214; color: #a9aeb7; font-size: var(--fs-micro); }
.uw-agent-scope strong { color: #e3e6eb; font-weight: var(--weight-semibold); overflow-wrap: anywhere; }
.uw-agent-scope small { flex: 1 1 100%; color: #a7abb4; font-size: var(--fs-micro); line-height: var(--lh-normal); }
.uw-agent-entry-goal-label { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.uw-agent-entry-goal { width: 100%; min-height: 58px; max-height: 180px; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #4c4e52; border-radius: 7px; background: #0a0a0a; color: var(--uw-ink); font: inherit; font-size: var(--fs-label); line-height: var(--lh-normal); resize: vertical; }
.uw-agent-entry-goal::placeholder { color: #92969e; }
.uw-agent-entry-goal:focus-visible, .uw-agent-entry-host:focus-visible { outline: 2px solid #e1e4e9; outline-offset: 2px; }
.uw-agent-entry-actions { display: flex; align-items: center; gap: var(--sp-default); min-width: 0; }
.uw-agent-entry-help { flex: 1 1 auto; color: var(--uw-muted); font-size: var(--fs-micro); line-height: var(--lh-normal); }
.uw-agent-entry-host-label { flex: 0 1 auto; display: inline-flex; align-items: center; gap: var(--sp-cozy); color: var(--uw-muted); font-size: var(--fs-micro); white-space: nowrap; }
.uw-agent-entry-host { max-width: 180px; min-height: 38px; padding: var(--sp-cozy); border: 1px solid #5c6066; border-radius: 7px; color: var(--uw-ink); background: #1d1d1d; font: inherit; font-size: var(--fs-label); }
.uw-agent-entry-submit { display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-cozy); min-height: 38px; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #d8dce2; border-radius: 7px; background: #e0e3e7; color: #101113; font: inherit; font-size: var(--fs-label); font-weight: var(--weight-semibold); white-space: nowrap; cursor: pointer; }
.uw-agent-entry-submit .uw-icon { width: 16px; height: 16px; }
.uw-agent-entry-submit:hover:not(:disabled) { background: #ffffff; }
.uw-agent-entry-submit:disabled { border-color: #4b4c50; background: #27282a; color: #9599a1; cursor: not-allowed; }
.uw-agent-host-status { padding: 0 var(--sp-cozy); color: var(--uw-muted); font-size: var(--fs-micro); line-height: var(--lh-normal); }
.uw-agent-host-status[hidden] { display: none; }
.uw-agent-host-status summary { width: fit-content; cursor: pointer; padding: var(--sp-cozy) 0; text-decoration: underline; text-underline-offset: 3px; }
.uw-agent-host-status summary:focus-visible { outline: 2px solid #e1e4e9; outline-offset: 2px; }
.uw-agent-host-status ul { margin: 0; padding: 0 0 var(--sp-cozy); list-style: none; display: grid; gap: var(--sp-cozy); }
.uw-agent-host-status li { padding: var(--sp-cozy) var(--sp-default); background: #1b1c1e; border-left: 2px solid #666a72; border-radius: 4px; overflow-wrap: anywhere; }
.uw-agent-host-status li[data-state="ready"] { border-color: #8c929a; color: #e1e3e7; }
.uw-agent-entry-status { padding: var(--sp-cozy) var(--sp-default); border: 1px solid #46494e; border-radius: 7px; color: #d0d4dc; background: #202125; font-size: var(--fs-label); line-height: var(--lh-normal); overflow-wrap: anywhere; }
.uw-agent-entry-status[data-state="blocked"], .uw-agent-entry-status[data-state="unconfirmed"] { border-color: #795d4f; color: #efc4ac; background: #27211e; }
.uw-agent-entry-result { padding: var(--sp-cozy) var(--sp-default); border: 1px solid #4d555b; border-radius: 7px; background: #121519; color: #e6e8eb; }
.uw-agent-entry-result summary { cursor: pointer; font-weight: var(--weight-semibold); font-size: var(--fs-label); }
.uw-agent-entry-result pre { overflow: auto; max-height: 340px; margin: var(--sp-cozy) 0; font: inherit; font-size: var(--fs-label); line-height: var(--lh-normal); white-space: pre-wrap; overflow-wrap: anywhere; }
.uw-agent-entry-raw { margin: var(--sp-cozy) 0; border: 1px solid #424852; border-radius: 6px; }
.uw-agent-entry-raw summary { padding: var(--sp-cozy); color: #b9c0ca; font-size: var(--fs-micro); cursor: pointer; }
.uw-agent-entry-raw pre { padding: var(--sp-cozy); }
.uw-agent-entry-result p { margin: 0; color: var(--uw-muted); font-size: var(--fs-micro); line-height: var(--lh-normal); }
.uw-agent-options { display: grid; gap: var(--sp-default); margin-top: var(--sp-default); }
.uw-agent-options[hidden] { display: none; }
.uw-agent-options-disclaimer { color: #dbbba8 !important; }
.uw-agent-options-summary { color: #dadde2 !important; font-size: var(--fs-label) !important; }
.uw-agent-options-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap: var(--sp-cozy); }
.uw-agent-option { display: grid; align-content: start; text-align: left; gap: var(--sp-cozy); padding: var(--sp-default); min-width: 0; border: 1px solid #50545c; border-radius: 7px; background: #1a1d20; color: #e4e7ec; font: inherit; cursor: pointer; }
.uw-agent-option strong { font-size: var(--fs-label); overflow-wrap: anywhere; }
.uw-agent-option p { font-size: var(--fs-micro); line-height: var(--lh-normal); overflow-wrap: anywhere; }
.uw-agent-option p span:first-child { color: #b4bbc4; }
.uw-agent-option-label { color: #c7cdd6; font-size: var(--fs-micro); }
.uw-agent-option[data-selected="true"] { border-color: var(--uw-running); box-shadow: inset 0 0 0 1px var(--uw-running); }
.uw-agent-option:focus-visible { outline: 2px solid #e1e4e9; outline-offset: 2px; }
.uw-agent-decision { display: grid; gap: var(--sp-cozy); padding: var(--sp-default); border: 1px solid #62666f; border-radius: 8px; background: linear-gradient(125deg,#1d1f23,#121315); }
.uw-agent-decision[hidden] { display: none; }
.uw-agent-decision-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-cozy); flex-wrap: wrap; }
.uw-agent-decision-heading h3 { margin: 0; font-size: var(--fs-label); color: #f1f2f5; }
.uw-agent-decision-heading span { color: #d2d5db; font-size: var(--fs-micro); }
.uw-agent-decision-note { margin: 0; color: #b7bbc4; font-size: var(--fs-micro); line-height: var(--lh-normal); }
.uw-agent-choice { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1.4fr); gap: var(--sp-default); }
.uw-agent-choice label { display: grid; align-content: start; gap: var(--sp-snug); color: #d5d9df; font-size: var(--fs-label); }
.uw-agent-choice label span { color: #a4aab3; font-size: var(--fs-micro); }
.uw-agent-choice input, .uw-agent-choice textarea { width: 100%; min-width: 0; min-height: 38px; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #525761; border-radius: 6px; background: #090a0c; color: var(--uw-ink); font: inherit; font-size: var(--fs-label); line-height: var(--lh-normal); }
.uw-agent-choice textarea { min-height: 58px; max-height: 180px; resize: vertical; }
.uw-agent-choice input:focus-visible, .uw-agent-choice textarea:focus-visible { outline: 2px solid #e1e4e9; outline-offset: 2px; }
.uw-agent-decision-feedback-label { color: #c9cdd4; font-size: var(--fs-micro); }
.uw-agent-decision-feedback { width: 100%; min-height: 60px; max-height: 220px; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #525761; border-radius: 6px; background: #090a0c; color: var(--uw-ink); font: inherit; font-size: var(--fs-label); line-height: var(--lh-normal); resize: vertical; }
.uw-agent-decision-feedback:focus-visible, .uw-agent-decision-actions button:focus-visible, .uw-agent-decision-reconcile:focus-visible, .uw-advanced-stages summary:focus-visible { outline: 2px solid #e1e4e9; outline-offset: 2px; }
.uw-agent-decision-actions { display: flex; flex-wrap: wrap; gap: var(--sp-cozy); }
.uw-agent-decision-actions button, .uw-agent-decision-reconcile { min-height: 38px; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #6a6e76; border-radius: 6px; background: #292c31; color: #e9ebee; font: inherit; font-size: var(--fs-label); cursor: pointer; }
.uw-agent-decision-actions .uw-agent-adopt { border-color: #c4c7cd; background: #e0e3e7; color: #121316; font-weight: var(--weight-semibold); }
.uw-agent-decision-actions button:disabled { opacity: .48; cursor: not-allowed; }
.uw-agent-decision-actions button:hover:not(:disabled), .uw-agent-decision-reconcile:hover { filter: brightness(1.15); }
.uw-agent-decision-receipt { margin: 0; color: #dadde3; font-size: var(--fs-label); line-height: var(--lh-normal); }
.uw-agent-decision-reconcile { justify-self: start; }
.uw-agent-design { display: grid; gap: var(--sp-default); padding: var(--sp-default); border: 1px solid #454a52; border-radius: 8px; background: #101214; }
.uw-agent-design[hidden] { display: none; }
.uw-agent-design-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--sp-default); }
.uw-agent-design-heading span { color: var(--uw-muted); font-size: var(--fs-micro); }
.uw-agent-design-heading h3 { margin: var(--sp-cozy) 0 0; font-size: var(--fs-entity-body); }
.uw-agent-design-heading button, .uw-agent-design button { min-height: 38px; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #676d76; border-radius: 6px; color: #e0e4e9; background: #282b30; font: inherit; font-size: var(--fs-label); cursor: pointer; }
.uw-agent-design button:disabled { opacity: .5; cursor: not-allowed; }
.uw-agent-design button:focus-visible, .uw-agent-design input:focus-visible, .uw-agent-design textarea:focus-visible, .uw-agent-design summary:focus-visible { outline: 2px solid #e1e4e9; outline-offset: 2px; }
.uw-agent-design-status { margin: 0; padding: var(--sp-cozy) var(--sp-default); border-left: 2px solid #797e86; color: #dadde3; background: #1d2024; font-size: var(--fs-label); overflow-wrap: anywhere; }
.uw-agent-design-status[data-state="blocked"], .uw-agent-design-status[data-state="stale"] { border-color: var(--uw-warm); color: #f0c3ad; }
.uw-agent-design-note { margin: 0; color: #aab0b8; font-size: var(--fs-micro); line-height: var(--lh-normal); }
.uw-agent-draft { display: grid; gap: var(--sp-cozy); padding: var(--sp-default); border: 1px solid #515762; border-radius: 7px; background: #181b1f; }
.uw-agent-draft[hidden] { display: none; }
.uw-agent-draft p { margin: 0; color: #d7dce3; font-size: var(--fs-label); line-height: var(--lh-normal); overflow-wrap: anywhere; }
.uw-agent-draft p[data-state="blocked"] { color: var(--uw-warm); }
.uw-agent-draft-actions { display: flex; gap: var(--sp-cozy); flex-wrap: wrap; }
.uw-agent-draft button { min-height: 38px; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #646b76; border-radius: 6px; background: #282c32; color: #e3e6eb; font: inherit; font-size: var(--fs-label); cursor: pointer; }
.uw-agent-draft button:disabled { opacity: .5; cursor: not-allowed; }
.uw-agent-draft button:focus-visible { outline: 2px solid #e1e4e9; outline-offset: 2px; }
.uw-agent-design-body { display: grid; gap: var(--sp-default); min-width: 0; }
.uw-agent-design-panel { display: grid; gap: var(--sp-default); min-width: 0; padding: var(--sp-default); border: 1px solid #3b3f45; border-radius: 7px; background: #15171a; }
.uw-agent-design-panel h4 { margin: 0; font-size: var(--fs-entity-body); line-height: var(--lh-normal); color: #e3e6ec; }
.uw-agent-design-panel p { margin: 0; color: #c7cbd2; font-size: var(--fs-body); line-height: var(--lh-normal); overflow-wrap: anywhere; white-space: pre-wrap; }
.uw-agent-design-panel summary { cursor: pointer; color: #e4e7eb; font-size: var(--fs-body); font-weight: var(--weight-semibold); }
.uw-agent-design-panel details.uw-agent-design-panel[data-current="true"] { border-color: #bb9560; background: #1c1b19; }
.uw-agent-module-summary { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--sp-cozy); }
.uw-agent-module-title { color: #e6e8ec; font-size: var(--fs-body); line-height: var(--lh-normal); }
.uw-agent-module-state { display: inline-flex; align-items: center; padding: var(--sp-cozy); border: 1px solid #4c525b; border-radius: var(--uw-radius); color: #bfc5ce; font-size: var(--fs-micro); font-weight: var(--weight-regular); white-space: nowrap; }
.uw-agent-module-state[data-state="approved"] { color: #c7d2d0; border-color: #485b54; }
.uw-agent-module-state[data-state="invalidated"], .uw-agent-module-state[data-state="revoked"] { color: #edb395; border-color: #825446; }
.uw-agent-design-facts { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--sp-default); margin: 0; }
.uw-agent-design-fact { display: grid; align-content: start; gap: var(--sp-snug); min-width: 0; padding: var(--sp-default); background: #111316; border: 1px solid #30343a; border-radius: 6px; }
.uw-agent-design-facts dt { font-size: var(--fs-label); font-weight: var(--weight-regular); color: #a7aeb8; }
.uw-agent-design-facts dd { margin: 0; font-size: var(--fs-body); line-height: var(--lh-normal); color: #e0e3e8; overflow-wrap: anywhere; white-space: pre-wrap; }
.uw-agent-design-form { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--sp-default); }
.uw-agent-design-form label { display: grid; align-content: start; gap: var(--sp-cozy); min-width: 0; color: #d0d5dd; font-size: var(--fs-label); }
.uw-agent-design-form label[data-wide="true"] { grid-column: 1 / -1; }
.uw-agent-design-form input, .uw-agent-design-form textarea { width: 100%; min-width: 0; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #515762; border-radius: 6px; color: var(--uw-ink); background: #090b0d; font: inherit; line-height: var(--lh-normal); font-size: var(--fs-label); }
.uw-agent-design-form textarea { min-height: 64px; resize: vertical; }
.uw-agent-design-form small { color: var(--uw-muted); font-size: var(--fs-micro); }
.uw-agent-design-deps { display: flex; flex-wrap: wrap; gap: var(--sp-cozy); padding: 0; margin: 0; border: 0; }
.uw-agent-design-deps legend { color: #b2b8c1; font-size: var(--fs-micro); margin-bottom: var(--sp-cozy); }
.uw-agent-design-deps label { display: inline-flex; align-items: center; gap: var(--sp-cozy); padding: var(--sp-cozy); border: 1px solid #444a54; border-radius: 6px; font-size: var(--fs-micro); }
.uw-agent-design-deps input { width: 16px; height: 16px; }
.uw-agent-design-actions { display: flex; flex-wrap: wrap; gap: var(--sp-cozy); }
.uw-agent-design-approval { color: #b8bec6; font-size: var(--fs-micro); }
.uw-agent-design-approval[data-state="invalidated"] { color: var(--uw-warm); }
.uw-agent-transfer { display: grid; gap: var(--sp-default); min-width: 0; padding: var(--sp-default); border: 1px solid #454a52; border-radius: 8px; background: #111316; }
.uw-agent-transfer[hidden] { display: none; }
.uw-agent-transfer-actions { display: flex; gap: var(--sp-cozy); flex-wrap: wrap; }
.uw-agent-transfer button { min-height: 38px; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #676d76; border-radius: 6px; color: #e0e4e9; background: #282b30; font: inherit; font-size: var(--fs-label); cursor: pointer; }
.uw-agent-transfer button:disabled { opacity: .5; cursor: not-allowed; }
.uw-agent-transfer button:focus-visible { outline: 2px solid #e1e4e9; outline-offset: 2px; }
.uw-agent-transfer-receipt { display: grid; gap: var(--sp-cozy); min-width: 0; padding: var(--sp-cozy) var(--sp-default); background: #1b1e22; border: 1px solid #49505a; border-radius: 6px; font-size: var(--fs-micro); color: #cbd0d8; overflow-wrap: anywhere; }
.uw-agent-transfer-receipt[hidden] { display: none; }
.uw-agent-gate { display: grid; gap: var(--sp-default); min-width: 0; padding: var(--sp-default); border: 1px solid #454a52; border-radius: 8px; background: #111316; }
.uw-agent-gate[hidden] { display: none; }
.uw-agent-gate button { min-height: 38px; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #676d76; border-radius: 6px; color: #e0e4e9; background: #282b30; font: inherit; font-size: var(--fs-label); cursor: pointer; }
.uw-agent-gate button:focus-visible { outline: 2px solid #e1e4e9; outline-offset: 2px; }
.uw-agent-gate-list { display: grid; gap: var(--sp-cozy); list-style: none; margin: 0; padding: 0; }
.uw-agent-gate-list li { display: grid; grid-template-columns: minmax(0,155px) minmax(0,1fr); gap: var(--sp-default); padding: var(--sp-cozy) var(--sp-default); background: #1b1e22; border: 1px solid #373d46; border-radius: 6px; font-size: var(--fs-label); }
.uw-agent-gate-list li > strong { color: #dadde4; font-weight: var(--weight-semibold); }
.uw-agent-gate-list li > span { color: #b5bdc6; overflow-wrap: anywhere; }
.uw-agent-entry-recovery { display: flex; gap: var(--sp-default); flex-wrap: wrap; }
.uw-agent-entry-recovery[hidden] { display: none; }
.uw-agent-entry-recovery button { min-height: 34px; padding: var(--sp-cozy); border: 1px solid #666970; border-radius: 6px; background: #292a2d; color: #e0e3e8; font: inherit; font-size: var(--fs-micro); cursor: pointer; }
.uw-agent-entry-recovery button:hover { background: #36383d; }
.uw-user-flow { min-width: 0; margin: 0 var(--uw-page-gap) var(--sp-default); border: 1px solid var(--uw-border); border-radius: var(--uw-radius); overflow: hidden; background: linear-gradient(145deg,#18191b,#0c0d0e); }
.uw-user-flow-heading { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: var(--sp-cozy) var(--sp-default); padding: var(--sp-default) var(--sp-default) 0; }
.uw-user-flow-heading strong { color: #e2e5eb; font-size: var(--fs-label); }
.uw-user-flow-heading span { color: #999fa8; font-size: var(--fs-micro); line-height: var(--lh-normal); }
.uw-phase-strip { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: var(--sp-snug); margin: 0; padding: var(--sp-default); list-style: none; }
.uw-phase { display: flex; align-items: center; gap: var(--sp-cozy); min-width: 0; padding: var(--sp-cozy); border: 1px solid #33363c; border-radius: 7px; background: #151618; color: #afb4bd; }
.uw-phase-number { display: grid; flex: 0 0 auto; place-items: center; width: 28px; height: 28px; border: 1px solid #585d65; border-radius: 6px; color: #c9cdd4; font-size: var(--fs-micro); }
.uw-phase-copy { display: grid; min-width: 0; gap: var(--sp-snug); }
.uw-phase-copy strong { color: #e0e3e8; font-size: var(--fs-label); overflow-wrap: anywhere; }
.uw-phase-copy small { color: #9da3ad; font-size: var(--fs-micro); overflow-wrap: anywhere; }
.uw-phase[data-state="running"] { border-color: var(--uw-running); background: #282217; box-shadow: 0 0 14px var(--uw-running-glow); }
.uw-phase[data-state="running"] .uw-phase-number { color: #19150e; border-color: var(--uw-running); background: var(--uw-running); }
.uw-phase[data-state="completed"] .uw-phase-number { color: #ecedf0; border-color: #737a84; background: #363a41; }
.uw-phase[data-state="blocked"], .uw-phase[data-state="waiting_human"] { border-color: #795d4f; }
.uw-phase[data-state="blocked"] .uw-phase-copy small, .uw-phase[data-state="waiting_human"] .uw-phase-copy small { color: var(--uw-warm); }
.uw-advanced-stages { border-top: 1px solid #303238; }
.uw-advanced-stages summary { padding: var(--sp-cozy) var(--sp-default); color: #bfc4cc; font-size: var(--fs-micro); cursor: pointer; }
.uw-advanced-stages[open] summary { border-bottom: 1px solid #2e3137; }
.uw-stage-strip { min-width: 0; display: grid; grid-template-columns: repeat(8,minmax(0,1fr)); gap: 0; margin: 0 var(--uw-page-gap) var(--sp-default); padding: var(--sp-cozy) var(--sp-snug); border: 1px solid var(--uw-border); border-radius: var(--uw-radius); background: linear-gradient(180deg,#18191b,#101112); }
.uw-advanced-stages .uw-stage-strip { margin: 0; border: 0; border-radius: 0; background: transparent; }
.uw-stage { display: flex; align-items: center; gap: var(--sp-cozy); min-width: 0; border: 0; border-right: 1px solid var(--uw-soft); padding: 0 var(--sp-default); background: transparent; text-align: left; color: #8f939a; cursor: pointer; }.uw-stage:last-child { border-right: 0; }
.uw-stage-number { display: grid; place-items: center; flex: 0 0 auto; width: 23px; height: 23px; font-size: var(--fs-micro); border-radius: 50%; border: 1px solid #4c5056; }
.uw-stage-copy { min-width: 0; display: grid; gap: var(--sp-snug); }.uw-stage-copy strong { color: #c4c8cf; font-size: var(--fs-micro); white-space: nowrap; }.uw-stage-copy small { font-size: var(--fs-micro); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uw-stage[data-state="active"], .uw-stage[data-state="running"], .uw-stage[data-state="current"] { color: var(--uw-running); }.uw-stage[data-state="active"] .uw-stage-number, .uw-stage[data-state="running"] .uw-stage-number, .uw-stage[data-state="current"] .uw-stage-number { background: #302719; border-color: var(--uw-running); box-shadow: 0 0 12px var(--uw-running-glow); }.uw-stage[data-state="completed"] .uw-stage-number { color: #ccd0d6; border-color: #666b73; }.uw-stage[data-state="blocked"], .uw-stage[data-state="waiting_human"] { color: var(--uw-warm); }
.uw-notice { margin: 0 var(--uw-page-gap) var(--sp-default); padding: var(--sp-default) var(--sp-default); border: 1px solid #645048; border-radius: 8px; color: var(--uw-warm); background: #24201e; font-size: var(--fs-label); line-height: var(--lh-normal); overflow-wrap: anywhere; }
.uw-body { position: relative; isolation: isolate; display: grid; grid-template-columns: minmax(0,1fr); min-width: 0; min-height: 0; gap: 0; border-top: 1px solid var(--uw-border); background: #070707; }
.uw-body::before { content: ""; position: absolute; z-index: 0; inset: 0; pointer-events: none; background: radial-gradient(ellipse 38% 52% at 84% 70%,#59616b0c,transparent 76%),radial-gradient(ellipse 36% 38% at 18% 13%,#66717e08,transparent 82%); background-size: 118% 118%; background-position: 0 0; animation: uw-ambient-field 22s ease-in-out infinite alternate; }
.uw-body > .uw-primary { position: relative; z-index: 1; }.uw-body > .uw-detail { z-index: 1; }
.uw-workspace[data-detail-open="true"] .uw-body { grid-template-columns: minmax(0,1fr) var(--uw-detail-width); }
.uw-primary { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto auto minmax(0,1fr) auto; }
.uw-heading-copy { min-width: 0; flex: 1 1 auto; }
.uw-content-header { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-default); padding: var(--sp-default) var(--uw-page-gap) var(--sp-cozy); }.uw-content-header h2 { margin: var(--sp-cozy) 0 0; font-size: var(--fs-view-title); }.uw-eyebrow { margin: 0; color: var(--uw-muted); font-size: var(--fs-micro); line-height: var(--lh-normal); }.uw-content-actions { flex: 0 0 auto; display: flex; align-items: center; gap: var(--sp-cozy); }.uw-data-state { color: #a9adb4; font-size: var(--fs-micro); }
.uw-toolbar { padding: 0 var(--uw-page-gap) var(--sp-default); display: flex; gap: var(--sp-cozy); align-items: center; flex-wrap: wrap; }.uw-toolbar:empty { display: none; }
.uw-input, .uw-select, .uw-textarea { min-width: 0; border: 1px solid var(--uw-border); border-radius: 7px; color: var(--uw-ink); background: var(--uw-surface); font: inherit; font-size: var(--fs-label); }.uw-input { min-height: 34px; padding: var(--sp-cozy) var(--sp-default); flex: 1; max-width: 320px; }.uw-select { min-height: 34px; padding: var(--sp-snug) var(--sp-cozy); max-width: 100%; }.uw-textarea { display: block; width: 100%; min-height: 112px; padding: var(--sp-default); line-height: var(--lh-normal); resize: vertical; }
.uw-segmented { display: inline-flex; max-width: 100%; gap: var(--sp-snug); padding: var(--sp-tight); border: 1px solid var(--uw-border); border-radius: 8px; background: #151618; }.uw-segmented button { line-height: var(--lh-flat); padding: var(--sp-snug) var(--sp-default); min-height: 29px; border: 0; border-radius: 5px; color: var(--uw-muted); background: transparent; font-size: var(--fs-label); cursor: pointer; transition: background .18s ease,color .18s ease,box-shadow .18s ease; }.uw-segmented button[aria-pressed="true"] { color: var(--uw-ink); background: #292b30; box-shadow: inset 0 -2px 0 #cbd0d6; }
.uw-main-content { overflow: auto; container: uw-content / inline-size; min-width: 0; min-height: 0; padding: 0 var(--uw-page-gap) var(--sp-section); scroll-padding-block-end: var(--sp-roomy); scrollbar-width: thin; scrollbar-color: #51565e transparent; }.uw-content-footer { padding: var(--sp-cozy) var(--uw-page-gap); color: var(--uw-muted); font-size: var(--fs-micro); line-height: var(--lh-normal); text-align: right; }.uw-content-footer:empty { padding: 0; }
.uw-task-list { display: grid; border-top: 1px solid var(--uw-border); }.uw-task-row { display: grid; grid-template-columns: 8px minmax(0,1fr) auto; align-items: center; gap: var(--sp-default); width: 100%; min-height: 66px; padding: var(--sp-default) var(--sp-cozy); border: 0; border-bottom: 1px solid var(--uw-soft); background: transparent; text-align: left; cursor: pointer; }.uw-task-row:hover, .uw-task-row[data-selected="true"] { background: var(--uw-raised); }.uw-task-dot { width: 6px; height: 6px; border-radius: 50%; background: #8b8f96; }.uw-task-row[data-state="completed"] .uw-task-dot { background: #c0c5cc; }.uw-task-row[data-state="running"] .uw-task-dot, .uw-task-row[data-state="active"] .uw-task-dot { background: var(--uw-running); box-shadow: 0 0 9px var(--uw-running-glow); }.uw-task-row[data-state="blocked"] .uw-task-dot, .uw-task-row[data-state="waiting_human"] .uw-task-dot { background: var(--uw-warm); }
.uw-task-copy { min-width: 0; display: grid; gap: var(--sp-cozy); }.uw-task-copy strong { color: var(--uw-ink); font-size: var(--fs-entity-body); line-height: var(--lh-normal); overflow-wrap: anywhere; }.uw-task-copy small { color: #aeb2b9; font-size: var(--fs-micro); line-height: var(--lh-normal); overflow-wrap: anywhere; }.uw-task-state { max-width: 112px; font-size: var(--fs-micro); color: var(--uw-muted); text-align: right; line-height: var(--lh-normal); }
.uw-empty { max-width: 480px; margin: clamp(16px,4vh,42px) auto; text-align: center; padding: var(--sp-section) var(--sp-roomy); }.uw-empty-mark { position: relative; width: 40px; height: 40px; display: grid; place-items: center; margin: 0 auto var(--sp-roomy); border: 1px solid #555a62; border-radius: 12px; color: var(--uw-accent); background: var(--uw-surface); box-shadow: 0 0 28px #ffffff09; }.uw-empty-mark::after { content: ""; position: absolute; inset: -7px; border: 1px solid #858b9520; border-radius: 12px; animation: uw-idle-orbit 9s ease-in-out infinite; pointer-events: none; }.uw-empty h3 { margin: 0 0 var(--sp-default); font-size: var(--fs-body); }.uw-empty p { margin: 0; color: var(--uw-muted); font-size: var(--fs-label); line-height: var(--lh-normal); overflow-wrap: anywhere; }
.uw-detail { display: flex; flex-direction: column; min-height: 0; min-width: 0; border-left: 1px solid var(--uw-border); background: var(--uw-surface); }.uw-detail-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-default); padding: var(--sp-section); border-bottom: 1px solid var(--uw-soft); }.uw-detail-header h2 { margin: var(--sp-cozy) 0 0; color: var(--uw-ink); font-size: var(--fs-body); line-height: var(--lh-normal); overflow-wrap: anywhere; }.uw-detail-body { min-height: 0; overflow: auto; padding: var(--sp-roomy) var(--sp-section); scrollbar-width: thin; }
.uw-section { padding: 0 0 var(--sp-section); margin-bottom: var(--sp-section); border-bottom: 1px solid var(--uw-soft); }.uw-section:last-child { border-bottom: 0; }.uw-section h3 { margin: 0 0 var(--sp-default); font-size: var(--fs-label); }.uw-section p { margin: var(--sp-cozy) 0; font-size: var(--fs-label); line-height: var(--lh-normal); color: #c8cbd0; overflow-wrap: anywhere; }.uw-facts { margin: 0; display: grid; grid-template-columns: 76px minmax(0,1fr); gap: var(--sp-default) var(--sp-default); font-size: var(--fs-micro); line-height: var(--lh-normal); }.uw-facts dt { color: #a0a4ab; }.uw-facts dd { margin: 0; color: #dee1e6; overflow-wrap: anywhere; }
.uw-document { max-width: 820px; margin-inline: auto; }.uw-document-header { display: flex; flex-wrap: wrap; gap: var(--sp-cozy); align-items: center; padding: var(--sp-default) 0; border-top: 1px solid var(--uw-border); border-bottom: 1px solid var(--uw-soft); }.uw-document-header h3 { flex: 1 1 240px; min-width: 0; margin: 0; font-size: var(--fs-view-title); line-height: var(--lh-normal); overflow-wrap: anywhere; }.uw-version { line-height: var(--lh-flat); display: inline-flex; padding: var(--sp-hairline) var(--sp-cozy); border: 1px solid #50555c; border-radius: 5px; color: #c2c7cf; background: #25272c; font-size: var(--fs-micro); }.uw-source-ref { font-size: var(--fs-micro); color: #a8adb5; overflow-wrap: anywhere; }.uw-document-body { padding: var(--sp-default) 0; }.uw-document-body p, .uw-document-body li { font-size: var(--fs-entity-body); line-height: var(--lh-normal); color: #cdd0d6; overflow-wrap: anywhere; white-space: pre-wrap; }.uw-document-body h3, .uw-document-body h4 { margin: var(--sp-section) 0 var(--sp-default); color: var(--uw-ink); font-size: var(--fs-body); line-height: var(--lh-normal); }.uw-document-body pre { white-space: pre-wrap; overflow-wrap: anywhere; line-height: var(--lh-normal); font-size: var(--fs-label); padding: var(--sp-roomy); border: 1px solid var(--uw-border); border-radius: 8px; background: #101113; }
.uw-actions { display: flex; flex-wrap: wrap; gap: var(--sp-cozy); margin-top: var(--sp-default); }.uw-button { display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-cozy); min-height: 34px; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #666b73; border-radius: 7px; background: #2b2e33; color: #e0e4ea; font-size: var(--fs-label); line-height: var(--lh-normal); cursor: pointer; text-decoration: none; transition: background .18s ease,box-shadow .18s ease; }.uw-button.secondary { background: #1a1c20; border-color: var(--uw-border); color: #c6cbd2; }.uw-button:disabled { opacity: .5; cursor: not-allowed; }.uw-button:hover:not(:disabled) { background: #383c42; box-shadow: 0 0 12px #ffffff0b; }.uw-pagination { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: var(--sp-default); margin-top: var(--sp-roomy); font-size: var(--fs-micro); color: var(--uw-muted); }
.uw-decision { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: var(--sp-cozy) var(--sp-default); padding: var(--sp-default) var(--sp-roomy); margin: var(--sp-default) 0; border: 1px solid #514846; border-left: 2px solid var(--uw-warm); border-radius: 7px; background: linear-gradient(96deg,#231e1d,#19191c 80%); }.uw-decision h3 { grid-column: 1; margin: 0; font-size: var(--fs-entity-body); color: #edc4ab; }.uw-decision p { grid-column: 1; margin: 0; color: #c4c6cb; font-size: var(--fs-label); line-height: var(--lh-normal); overflow-wrap: anywhere; }.uw-decision .uw-actions { grid-column: 2; grid-row: 1 / span 3; margin: 0; align-self: center; }.uw-command-status { margin: var(--sp-cozy) 0; color: #c2c8c4; font-size: var(--fs-label); line-height: var(--lh-normal); border-left: 2px solid #78827c; padding-left: var(--sp-default); overflow-wrap: anywhere; }.uw-feedback-label { display: block; margin-bottom: var(--sp-cozy); color: #aab0b8; font-size: var(--fs-micro); }
.uw-timeline { padding-left: 0; margin: 0; list-style: none; }.uw-timeline-item { display: grid; grid-template-columns: 12px minmax(0,1fr); gap: var(--sp-default); padding: 0 0 var(--sp-section); }.uw-timeline-marker { position: relative; padding-top: var(--sp-snug); }.uw-timeline-marker::before { content: ''; display: block; width: 6px; height: 6px; border: 1px solid #777d85; border-radius: 50%; background: #34383e; }.uw-timeline-marker::after { content: ''; position: absolute; left: 3px; top: 18px; bottom: -16px; border-left: 1px solid var(--uw-border); }.uw-timeline-item:last-child .uw-timeline-marker::after { display: none; }.uw-timeline-copy { min-width: 0; }.uw-timeline-copy strong { font-size: var(--fs-label); line-height: var(--lh-normal); overflow-wrap: anywhere; }.uw-timeline-copy p { margin: var(--sp-cozy) 0; color: var(--uw-muted); font-size: var(--fs-micro); line-height: var(--lh-normal); overflow-wrap: anywhere; }.uw-timeline-copy time { color: #9298a1; font-size: var(--fs-micro); }
.uw-skeleton { display: grid; gap: var(--sp-roomy); padding: var(--sp-roomy) 0; }.uw-skeleton span { display: block; height: 38px; background: linear-gradient(90deg,#1b1d20,#2b2e33,#1b1d20); background-size: 220% 100%; border-radius: 7px; animation: uw-loading 1.4s linear infinite; }.uw-skeleton span:nth-child(2) { width: 85%; }.uw-skeleton span:nth-child(3) { width: 65%; }@keyframes uw-loading { to { background-position: -220% 0; } }
.uw-workspace-footer { display: flex; justify-content: center; align-items: center; gap: var(--sp-default); flex-wrap: wrap; min-height: 28px; padding: var(--sp-cozy) var(--sp-roomy); border-top: 1px solid var(--uw-soft); color: #969ba4; font-size: var(--fs-micro); text-align: center; overflow-wrap: anywhere; }
.uw-workspace button:focus-visible, .uw-navigation button:focus-visible, .uw-workspace input:focus-visible, .uw-workspace select:focus-visible, .uw-workspace textarea:focus-visible { outline: 2px solid var(--uw-accent); outline-offset: 3px; }
.uw-next-action { padding: var(--sp-default) var(--sp-section); margin: 0 0 var(--sp-default); border: 1px solid #51555d; border-radius: var(--uw-radius); background: linear-gradient(135deg,#25282d,#17181b); box-shadow: inset 2px 0 0 #aeb4bd; }
.uw-next-action h3 { margin: var(--sp-cozy) 0 var(--sp-roomy); color: var(--uw-ink); font-size: var(--fs-entity-title); line-height: var(--lh-snug); overflow-wrap: anywhere; }
.uw-next-action p { margin: 0 0 var(--sp-roomy); color: var(--uw-muted); font-size: var(--fs-label); }
.uw-table-wrap { max-width: 100%; overflow-x: auto; margin: var(--sp-roomy) 0; border: 1px solid var(--uw-border); border-radius: 8px; }
.uw-table { width: 100%; border-collapse: collapse; font-size: var(--fs-label); line-height: var(--lh-normal); text-align: left; }
.uw-table th, .uw-table td { min-width: 100px; padding: var(--sp-default) var(--sp-default); border-bottom: 1px solid var(--uw-border); overflow-wrap: anywhere; vertical-align: top; }
.uw-table th { background: #25282d; color: var(--uw-ink); font-weight: var(--weight-semibold); }.uw-table td { color: #cdd1d8; }
.uw-evidence-refs { padding-left: var(--sp-roomy); color: #cdd1d8; font-size: var(--fs-label); line-height: var(--lh-normal); overflow-wrap: anywhere; }
.uw-version { max-width: 100%; min-width: 0; overflow-wrap: anywhere; }
.uw-task-state { overflow-wrap: anywhere; }
.uw-module-nav .uw-structure-root { font-size: var(--fs-entity-body); color: #e5e8ed; margin-bottom: var(--sp-snug); background: #222428; border: 1px solid #474b52; min-height: 42px; }
.uw-module-nav .uw-structure-root::before { display: none; }.uw-structure-number { display: grid; place-items: center; flex: 0 0 auto; width: 26px; height: 26px; background: #2a2d32; color: #d5d9df; border: 1px solid #51555d; border-radius: 6px; font-size: var(--fs-micro); }
.uw-module-nav .uw-structure-root[data-selected="true"] { border-color: #666b74; background: #2b2e34; }
.uw-structure-search { width: calc(100% - 12px); margin: var(--sp-snug); min-height: 34px; padding: var(--sp-cozy); border: 1px solid #474b52; border-radius: 8px; background: var(--uw-surface); color: var(--uw-ink); font-size: var(--fs-label); }
.uw-structure-search:focus-visible { outline: 2px solid var(--uw-accent); outline-offset: 1px; }
.uw-structure-children { margin-left: var(--sp-default); padding-left: var(--sp-cozy); border-left: 1px solid var(--uw-border); }.uw-module-nav .uw-structure-children button { min-height: 35px; }.uw-module-nav button[hidden] { display: none; }
.uw-prd-layout { display: grid; width: 100%; grid-template-columns: minmax(0,1.08fr) minmax(0,.92fr); align-items: start; gap: clamp(12px,1.2vw,20px); min-width: 0; margin: 0 auto; }
.uw-prd-layout > .uw-knowledge-graph { position: sticky; top: 0; }
.uw-prd-layout[data-prd-mode="module"] { grid-template-columns: minmax(0,1fr); }
.uw-prd-layout[data-prd-mode="module"] > .uw-knowledge-graph { position: static; }
.uw-prd-layout > .uw-document { margin: 0; min-width: 0; max-width: none; padding: var(--sp-roomy) clamp(18px,2vw,34px) var(--sp-section); border: 1px solid var(--uw-border); border-radius: var(--uw-radius); background: linear-gradient(145deg,#17191c,#0c0d0f 58%); }
.uw-prd-layout .uw-document-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-default); padding: 0 0 var(--sp-default); border-top: 0; }
.uw-document-heading { display: grid; align-content: start; gap: var(--sp-cozy); min-width: 0; }
.uw-document-heading h3 { margin: 0; font-size: var(--fs-view-title); line-height: var(--lh-snug); overflow-wrap: anywhere; }
.uw-document-meta { display: flex; flex-direction: column; align-items: flex-end; justify-content: flex-start; gap: var(--sp-cozy); flex: 0 1 auto; }
.uw-document-meta .uw-version { max-width: 200px; overflow-wrap: anywhere; }
.uw-document-state { display: inline-flex; align-items: center; gap: var(--sp-cozy); color: var(--uw-muted); font-size: var(--fs-micro); white-space: nowrap; }
.uw-document-state::before { content: ""; width: 5px; height: 5px; border-radius: 100%; background: currentColor; }
.uw-document-state[data-state="waiting_human"], .uw-document-state[data-state="blocked"] { color: var(--uw-warm); }
.uw-document-state[data-state="running"], .uw-document-state[data-state="active"] { color: var(--uw-running); }
.uw-prd-layout .uw-document-body .uw-section { margin: 0 0 var(--sp-default); padding: 0 0 var(--sp-default); }.uw-prd-facts-list { padding-left: var(--sp-roomy); margin: var(--sp-cozy) 0 0; }
.uw-prd-layout[data-prd-mode="module"] .uw-prd-structured { column-count: 2; column-gap: clamp(24px,3vw,48px); column-rule: 1px solid var(--uw-soft); }
.uw-prd-layout[data-prd-mode="module"] > .uw-document > .uw-section { margin: 0 0 var(--sp-default); padding: 0 0 var(--sp-default); }
.uw-prd-layout[data-prd-mode="module"] .uw-document-body { padding-top: 0; }
.uw-prd-structured .uw-section { break-inside: avoid; }
.uw-prd-reference-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(170px,1fr)); gap: var(--sp-cozy); }.uw-prd-reference-grid .uw-section { min-width: 0; }
.uw-prd-raw { margin: var(--sp-roomy) 0; padding: var(--sp-default); border: 1px solid var(--uw-border); border-radius: 8px; background: #111315; }.uw-prd-raw summary { font-size: var(--fs-label); color: var(--uw-accent); cursor: pointer; }
.uw-prd-raw pre { max-height: 420px; overflow: auto; color: #cbd0d8; }
.uw-knowledge-graph { min-width: 0; overflow: hidden; border: 1px solid #41454c; border-radius: var(--uw-radius); background: #0d0e10; box-shadow: 0 14px 40px #0009; }
.uw-knowledge-surface { display: grid; grid-template-columns: minmax(0,1.6fr) minmax(0,1fr); min-width: 0; align-items: stretch; }
.uw-knowledge-map { min-width: 0; display: flex; flex-direction: column; }
.uw-knowledge-index { min-width: 0; display: flex; flex-direction: column; border-left: 1px solid #393d44; background: linear-gradient(142deg,#1a1c20,#101113 64%); }
.uw-knowledge-index-heading { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-default); min-height: 45px; padding: var(--sp-cozy) var(--sp-default); border-bottom: 1px solid var(--uw-border); }
.uw-knowledge-index-kicker { color: #afb5bf; font-size: var(--fs-micro); letter-spacing: 0; }
.uw-knowledge-index-count { color: #d9dde3; font-size: var(--fs-body); font-variant-numeric: tabular-nums; font-weight: var(--weight-semibold); }
.uw-knowledge-index-list { display: grid; align-content: start; max-height: 480px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #51565e transparent; }
.uw-knowledge-index-row { display: grid; grid-template-columns: 26px minmax(0,1fr) auto; align-items: start; gap: var(--sp-cozy); width: 100%; min-width: 0; padding: var(--sp-default); border: 0; border-bottom: 1px solid #31343a; border-left: 2px solid transparent; background: transparent; color: var(--uw-ink); text-align: left; cursor: pointer; transition: background .18s ease,border-color .18s ease; }
.uw-knowledge-index-row:hover, .uw-knowledge-index-row:focus-visible { background: #24272c; border-left-color: #a6abb4; }
.uw-knowledge-index-row[data-selected="true"] { background: #282b30; border-left-color: #c8cdd4; }
.uw-knowledge-index-row[data-state="running"], .uw-knowledge-index-row[data-state="active"] { border-left-color: var(--uw-running); }.uw-knowledge-index-row[data-state="running"] .uw-knowledge-index-number, .uw-knowledge-index-row[data-state="active"] .uw-knowledge-index-number { color: var(--uw-running); }
.uw-knowledge-index-number { grid-column: 1; color: #c0c6ce; font-size: var(--fs-micro); font-variant-numeric: tabular-nums; }
.uw-knowledge-index-copy { display: grid; gap: var(--sp-cozy); grid-column: 2; min-width: 0; }
.uw-knowledge-index-copy strong { color: #e8ecf2; font-size: var(--fs-label); font-weight: var(--weight-semibold); line-height: var(--lh-snug); overflow-wrap: anywhere; }
.uw-knowledge-index-copy small { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; color: #a0a6b0; font-size: var(--fs-micro); line-height: var(--lh-normal); overflow-wrap: anywhere; }
.uw-knowledge-index-copy .uw-knowledge-index-links { color: #b8c1ce; -webkit-line-clamp: 2; }
.uw-knowledge-index-state { grid-column: 3; color: #aeb4bd; font-size: var(--fs-micro); white-space: nowrap; }
.uw-knowledge-index-row[data-state="waiting_human"] .uw-knowledge-index-state, .uw-knowledge-index-row[data-state="blocked"] .uw-knowledge-index-state { color: var(--uw-warm); }
.uw-knowledge-index-row[data-state="running"] .uw-knowledge-index-state, .uw-knowledge-index-row[data-state="active"] .uw-knowledge-index-state { color: var(--uw-running); }
.uw-knowledge-graph[data-live-prd-knowledge-graph="module"] .uw-knowledge-surface { grid-template-columns: minmax(0,540px) minmax(0,1fr); }
.uw-knowledge-graph[data-live-prd-knowledge-graph="module"] .uw-knowledge-index-list { grid-template-columns: repeat(2,minmax(0,1fr)); }
.uw-knowledge-graph[data-live-prd-knowledge-graph="module"] .uw-knowledge-index-row { border-right: 1px solid var(--uw-soft); }
.uw-knowledge-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--sp-cozy); padding: var(--sp-default) var(--sp-roomy); border-bottom: 1px solid var(--uw-border); background: linear-gradient(90deg,#24272c,#121416); }
.uw-knowledge-controls { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-cozy); }
.uw-knowledge-camera { display: inline-flex; align-items: center; gap: var(--sp-snug); padding: var(--sp-tight); border: 1px solid var(--uw-border); border-radius: 8px; background: #111315; }
.uw-knowledge-tool { line-height: var(--lh-flat); min-height: 26px; padding: var(--sp-tight) var(--sp-cozy); border: 0; border-radius: 5px; background: transparent; color: #cfd5df; font: inherit; font-size: var(--fs-micro); cursor: pointer; white-space: nowrap; }
.uw-knowledge-tool:hover { background: #262b34; color: #f6e3ba; }
.uw-knowledge-scale { font-variant-numeric: tabular-nums; color: #dec28a; }
.uw-knowledge-heading { display: grid; gap: var(--sp-cozy); }.uw-knowledge-kicker { color: var(--uw-muted); font-size: var(--fs-micro); }.uw-knowledge-heading h3 { margin: 0; color: var(--uw-ink); font-size: var(--fs-body); font-weight: var(--weight-semibold); }
.uw-knowledge-depth { display: flex; gap: var(--sp-cozy); padding: var(--sp-tight); border: 1px solid var(--uw-border); border-radius: var(--uw-radius); background: #111315; }.uw-knowledge-depth button { border: 0; border-radius: 5px; background: transparent; color: var(--uw-muted); font-size: var(--fs-micro); padding: var(--sp-cozy); cursor: pointer; }.uw-knowledge-depth button[aria-pressed="true"] { color: #141518; background: #d5d9df; }
.uw-knowledge-canvas { position: relative; max-height: min(58vh,580px); min-height: 0; overflow: auto; cursor: grab; background-color: #080808; background-image: radial-gradient(ellipse 65% 65% at 50% 20%,#5058660c,transparent 78%),linear-gradient(#7d858f13 1px,transparent 1px),linear-gradient(90deg,#7d858f13 1px,transparent 1px); background-size: 100% 100%,28px 28px,28px 28px; scrollbar-width: thin; scrollbar-color: #51565e transparent; }
.uw-knowledge-canvas[data-panning="true"], .uw-kg-node[data-dragging="true"] { cursor: grabbing; }
.uw-knowledge-graph[data-maximized="true"], .uw-flow-dag-card[data-maximized="true"] { position: fixed; inset: 16px; z-index: 95; width: auto; max-width: none; margin: 0; display: flex; flex-direction: column; border-color: #c8a96e; box-shadow: 0 24px 80px #000e; }
.uw-knowledge-graph[data-maximized="true"] .uw-knowledge-surface { flex: 1 1 auto; min-height: 0; }
.uw-knowledge-graph[data-maximized="true"] .uw-knowledge-canvas, .uw-flow-dag-card[data-maximized="true"] .uw-flow-dag-canvas { flex: 1 1 auto; max-height: none; height: 100%; }
.uw-knowledge-canvas::before { content: ""; position: absolute; z-index: 1; top: 0; left: 0; right: 0; height: 90px; pointer-events: none; background: linear-gradient(to bottom,transparent,#a4aebb07 60%,#c3cbd011 99%,transparent); animation: uw-radar-sweep 13s linear infinite; }
.uw-knowledge-canvas > svg { position: relative; z-index: 2; display: block; width: 100%; height: auto; max-width: var(--uw-graph-content-width,100%); min-width: var(--uw-graph-readable-width,0px); margin-inline: auto; }
.uw-kg-edge { fill: none; stroke-width: 1.4; pointer-events: stroke; }.uw-kg-edge.contains { stroke: #686e77; stroke-dasharray: 3 6; }.uw-kg-edge.required { stroke: var(--uw-graph-dependency); stroke-width: 1.8; }.uw-kg-arrow-head { fill: none; stroke: var(--uw-graph-dependency); stroke-width: 1.5; }
.uw-kg-edge[data-activity="observed-running"] { stroke: var(--uw-running); stroke-width: 2.4; stroke-dasharray: 8 8; animation: uw-graph-flow 1.8s linear infinite; filter: drop-shadow(0 0 4px var(--uw-running-glow)); }
.uw-kg-node { cursor: pointer; outline: none; }.uw-kg-node rect { fill: #181a1e; stroke: var(--uw-node-stroke); stroke-width: 1.35; transition: fill .22s ease,stroke .22s ease,filter .22s ease; }.uw-kg-node[data-kind="architecture"] rect { fill: #22252a; stroke: #bda06e; stroke-width: 1.8; }.uw-kg-node[data-selected="true"] rect, .uw-kg-node:hover rect, .uw-kg-node:focus-visible rect { stroke: #d2b783; stroke-width: 2.2; fill: #2b2f35; }.uw-kg-node[data-state="running"] rect, .uw-kg-node[data-state="active"] rect { stroke: var(--uw-running); stroke-width: 2.5; fill: #2f281c; filter: drop-shadow(0 0 10px var(--uw-running-glow)); }
.uw-kg-node-kind { fill: #c0c6cf; font-size: var(--fs-micro); }.uw-kg-node-state { fill: #aeb5bf; font-size: var(--fs-micro); }.uw-kg-node-title { fill: var(--uw-ink); font-size: var(--fs-entity-body); font-weight: var(--weight-semibold); }.uw-kg-node[data-state="waiting_human"] .uw-kg-node-state { fill: var(--uw-warm); }.uw-kg-node[data-state="running"] .uw-kg-node-state, .uw-kg-node[data-state="active"] .uw-kg-node-state { fill: var(--uw-running); }.uw-kg-node[data-state="completed"] .uw-kg-node-state, .uw-kg-node[data-state="accepted"] .uw-kg-node-state { fill: #c5cbd4; }
.uw-knowledge-legend { display: flex; flex-wrap: wrap; gap: var(--sp-section); padding: var(--sp-cozy) var(--sp-roomy) 0; color: #aeb5be; font-size: var(--fs-micro); }.uw-knowledge-legend span { display: inline-flex; align-items: center; gap: var(--sp-cozy); }.uw-knowledge-legend span::before { content: ''; display: inline-block; width: 22px; border-top: 2px dashed #7d848d; }.uw-knowledge-legend .required::before { border-color: var(--uw-graph-dependency); border-style: solid; }
.uw-knowledge-note { margin: var(--sp-cozy) var(--sp-roomy) var(--sp-default); font-size: var(--fs-micro); color: #aeb5be; line-height: var(--lh-normal); }.uw-knowledge-empty { margin: var(--sp-roomy); font-size: var(--fs-label); color: var(--uw-muted); }
.uw-knowledge-boundaries { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-default); padding: var(--sp-cozy) var(--sp-roomy) 0; color: #c3c8d1; font-size: var(--fs-label); }.uw-knowledge-more { min-height: 34px; padding: var(--sp-snug) var(--sp-default); border: 1px solid #606771; border-radius: 7px; background: #272a30; color: var(--uw-ink); cursor: pointer; }
.uw-knowledge-warning { padding: 0 var(--sp-roomy); margin: var(--sp-cozy) 0 0; color: #e6a490; font-size: var(--fs-label); }
@container uw-content (max-width: 1040px) { .uw-prd-layout { grid-template-columns: minmax(0,1fr); }.uw-prd-layout > .uw-knowledge-graph { position: static; }.uw-knowledge-canvas { max-height: 440px; } }
@container uw-content (max-width: 740px) { .uw-knowledge-surface, .uw-knowledge-graph[data-live-prd-knowledge-graph="module"] .uw-knowledge-surface { grid-template-columns: minmax(0,1fr); }.uw-knowledge-index { border-left: 0; border-top: 1px solid var(--uw-border); }.uw-knowledge-index-list, .uw-knowledge-graph[data-live-prd-knowledge-graph="module"] .uw-knowledge-index-list { grid-template-columns: repeat(2,minmax(0,1fr)); }.uw-prd-layout[data-prd-mode="module"] .uw-prd-structured { column-count: 1; }.uw-decision { grid-template-columns: minmax(0,1fr); }.uw-decision .uw-actions { grid-column: 1; grid-row: auto; } }
@container uw-content (max-width: 490px) { .uw-knowledge-map { display: none; }.uw-knowledge-index { border-top: 0; }.uw-knowledge-index-list, .uw-knowledge-graph[data-live-prd-knowledge-graph="module"] .uw-knowledge-index-list { grid-template-columns: minmax(0,1fr); max-height: none; }.uw-knowledge-index-row { min-height: 52px; grid-template-columns: 36px minmax(0,1fr); border-left: 0; border-right: 0; }.uw-knowledge-index-row[data-selected="true"] { box-shadow: inset 3px 0 #b9c0c9; }.uw-knowledge-index-row[data-state="running"], .uw-knowledge-index-row[data-state="active"] { box-shadow: inset 3px 0 var(--uw-running); }.uw-knowledge-index-number { justify-self: center; width: 28px; height: 28px; display: grid; place-items: center; padding-top: 0; border: 1px solid #565b64; border-radius: 100%; background: #292c31; }.uw-knowledge-index-row[data-selected="true"] .uw-knowledge-index-number { color: #151719; border-color: #cdd2d9; background: #cdd2d9; }.uw-knowledge-index-row[data-state="running"] .uw-knowledge-index-number, .uw-knowledge-index-row[data-state="active"] .uw-knowledge-index-number { color: #1a160e; border-color: var(--uw-running); background: var(--uw-running); box-shadow: 0 0 12px var(--uw-running-glow); }.uw-document-meta { align-items: flex-start; }.uw-prd-layout .uw-document-header { flex-direction: column; } }
@media (max-width: 767px) { .uw-prd-layout { gap: var(--sp-default); }.uw-knowledge-head { padding: var(--sp-default); }.uw-knowledge-canvas { max-height: 315px; }.uw-prd-layout > .uw-document { padding: var(--sp-default); }.uw-knowledge-note { margin: var(--sp-cozy) var(--sp-default) var(--sp-default); }.uw-module-nav .uw-structure-children button, .uw-knowledge-depth button, .uw-knowledge-more { min-height: 44px; }.uw-knowledge-depth { flex-wrap: wrap; }.uw-structure-search { min-height: 44px; } }
@media (max-width: 1260px) { :root { --uw-nav-width: 168px; --uw-detail-width: 310px; }.uw-stage { gap: var(--sp-snug); padding: 0 var(--sp-snug); }.uw-stage-number { width: 19px; height: 19px; }.uw-stage-copy strong { font-size: var(--fs-micro); } }
@media (max-width: 1080px) { :root { --uw-nav-width: 160px; }.uw-workspace[data-detail-open="true"] .uw-body { grid-template-columns: minmax(0,1fr); }.uw-detail { position: absolute; inset: 56px 0 0 auto; width: min(440px,calc(100% - var(--uw-nav-width))); z-index: 32; box-shadow: -18px 0 36px #0005; }.uw-phase-strip { grid-template-columns: repeat(3,minmax(0,1fr)); }.uw-stage-strip { grid-template-columns: repeat(4,minmax(0,1fr)); gap: var(--sp-roomy) 0; }.uw-stage:nth-child(4) { border-right: 0; } }
@media (max-width: 767px) { :root { --uw-page-gap: var(--sp-roomy); }.shell[data-unified-workspace="true"] { grid-template-columns: minmax(0,1fr); }.shell[data-unified-workspace="true"] > .topbar { padding-inline: var(--sp-default); gap: var(--sp-cozy); }.shell[data-unified-workspace="true"] > .main { grid-column: 1; }.shell[data-unified-workspace="true"] .brand-title { font-size: var(--fs-body); }.shell[data-unified-workspace="true"] .brand-mark { width: 24px; height: 24px; }.shell[data-unified-workspace="true"] .topbar-actions { gap: var(--sp-snug); }.shell[data-unified-workspace="true"] .topbar-actions > [data-live-open-help], .shell[data-unified-workspace="true"] .topbar-actions > [data-live-open-info], .shell[data-unified-workspace="true"] .topbar-actions > [data-live-open-sessions] { display: none; }.shell[data-unified-workspace="true"] .connection { max-width: 92px; font-size: var(--fs-micro); }.shell[data-unified-workspace="true"] .topbar-actions select { line-height: var(--lh-flat); width: 68px; min-width: 0; font-size: var(--fs-micro); padding-inline: var(--sp-tight); }.uw-navigation-toggle, .uw-mobile-close { display: inline-flex; align-items: center; justify-content: center; }.uw-navigation { display: none; position: absolute; inset: 56px auto 0 0; width: 268px; z-index: 40; box-shadow: 20px 0 60px #0008; }.uw-navigation[data-open="true"] { display: flex; }.uw-overview { grid-template-columns: minmax(0,1fr); padding-top: var(--sp-cozy); padding-bottom: var(--sp-cozy); }.uw-overview-meta { grid-column: 1; grid-row: auto; justify-content: flex-start; }.shell[data-work-view="workspace"] .uw-overview h1 { margin-top: 0; font-size: var(--fs-view-title); }.uw-overview-subtitle { font-size: var(--fs-micro); }.uw-stage-strip { margin-bottom: var(--sp-cozy); padding: var(--sp-cozy) var(--sp-tight); gap: var(--sp-cozy) 0; }.uw-stage { padding-inline: var(--sp-snug); }.uw-stage-copy { gap: var(--sp-snug); }.uw-stage-number { display: none; }.uw-stage-copy strong { font-size: var(--fs-micro); }.uw-stage-copy small { font-size: var(--fs-micro); }.uw-content-header { padding-top: var(--sp-default); }.uw-content-header h2 { font-size: var(--fs-view-title); }.uw-detail { position: fixed; inset: 56px 0 0; width: 100%; box-shadow: none; border-left: 0; z-index: 35; }.uw-task-row { gap: var(--sp-cozy); min-height: 72px; }.uw-task-state { max-width: 85px; }.uw-toolbar { gap: var(--sp-cozy); }.uw-input { flex-basis: 100%; max-width: none; }.uw-icon-button, .uw-button, .uw-select, .uw-navigation-toggle { min-height: 44px; }.uw-icon-button { width: 44px; }.uw-content-actions { gap: 0; }.uw-data-state { font-size: var(--fs-micro); }.uw-workspace-footer { font-size: var(--fs-micro); }.uw-nav-item { min-height: 44px; } }
@media (max-width: 767px) { .uw-agent-entry { padding: var(--sp-cozy) var(--sp-default); margin-bottom: var(--sp-cozy); }.uw-agent-entry-heading h2 { font-size: var(--fs-label); }.uw-agent-entry-actions { flex-wrap: wrap; }.uw-agent-entry-help { flex-basis: 100%; }.uw-agent-entry-host-label { flex: 1 1 auto; }.uw-agent-entry-host { flex: 1 1 auto; max-width: none; min-height: 44px; }.uw-agent-entry-submit { min-height: 44px; }.uw-agent-entry-recovery button { min-height: 44px; }.uw-agent-entry-goal { min-height: 54px; }.uw-agent-entry-result pre { max-height: min(30vh,220px); } }
@media (max-width: 767px) { .uw-phase-strip { grid-template-columns: repeat(2,minmax(0,1fr)); }.uw-phase:last-child { grid-column: 1 / -1; }.uw-phase { min-height: 52px; }.uw-agent-decision-actions button, .uw-agent-decision-reconcile { min-height: 44px; }.uw-agent-choice { grid-template-columns: minmax(0,1fr); }.uw-agent-scope { align-items: flex-start; }.uw-user-flow-heading { display: grid; } }
@media (max-width: 767px) { .uw-agent-design-form { grid-template-columns: minmax(0,1fr); }.uw-agent-design-form label[data-wide="true"] { grid-column: 1; }.uw-agent-design button, .uw-agent-transfer button, .uw-agent-draft button { min-height: 44px; }.uw-agent-design-panel { padding: var(--sp-cozy); }.uw-agent-design-facts { grid-template-columns: minmax(0,1fr); }.uw-agent-design-fact { padding: var(--sp-cozy); } }
@media (max-width: 767px) { .uw-agent-gate button { min-height: 44px; }.uw-agent-gate-list li { grid-template-columns: minmax(0,1fr); } }
@media (max-width: 767px) { .uw-agent-options-grid { grid-template-columns: minmax(0,1fr); }.uw-agent-option { min-height: 44px; } }
/* Agent desktop: one conversational input and one evidence-backed Live canvas.
   This layer changes presentation only; read/write receipts remain canonical. */
.uw-agent-live { display: none; }
.shell[data-unified-workspace="true"]:has(.uw-workspace[data-agent-entry-enabled="true"]) { grid-template-columns: var(--uw-nav-width) minmax(0,1fr); }
.shell[data-unified-workspace="true"]:has(.uw-workspace[data-agent-entry-enabled="true"]) > .main { grid-column: 2; }
.shell:has(.uw-workspace[data-agent-entry-enabled="true"]) .uw-navigation { display: flex; }
.shell:has(.uw-workspace[data-agent-entry-enabled="true"]) .uw-navigation[data-open="true"] { display: flex; position: relative; inset: auto; width: auto; z-index: auto; box-shadow: none; }
.shell:has(.uw-workspace[data-agent-entry-enabled="true"]) .uw-navigation-toggle { display: none; }
.uw-split-resizer { display: none; }
.uw-workspace[data-agent-entry-enabled="true"][data-view="work"]:has(> .uw-agent-entry > .uw-agent-chat) { grid-template-columns: minmax(310px, var(--uw-chat-share, 41%)) 6px minmax(380px, 1fr); grid-template-rows: minmax(0,1fr); height: 100%; gap: 0; overflow: hidden; background: #07090e; }
.uw-workspace[data-agent-entry-enabled="true"][data-view="work"] > .uw-overview, .uw-workspace[data-agent-entry-enabled="true"][data-view="work"] > .uw-user-flow, .uw-workspace[data-agent-entry-enabled="true"][data-view="work"] > .uw-notice, .uw-workspace[data-agent-entry-enabled="true"][data-view="work"] > .uw-body, .uw-workspace[data-agent-entry-enabled="true"][data-view="work"] > .uw-workspace-footer { display: none !important; }
.uw-workspace[data-agent-entry-enabled="true"]:not([data-view="work"]) > .uw-agent-entry, .uw-workspace[data-agent-entry-enabled="true"]:not([data-view="work"]) > .uw-split-resizer, .uw-workspace[data-agent-entry-enabled="true"]:not([data-view="work"]) > .uw-agent-live { display: none !important; }
.uw-workspace[data-agent-entry-enabled="true"][data-view="work"] > .uw-agent-entry { grid-column: 1; grid-row: 1; display: flex !important; min-width: 0; min-height: 0; margin: 0; padding: 0; border: 0; border-radius: 0; background: linear-gradient(180deg,#0c1017,#090c12); box-shadow: none; }
.uw-workspace[data-agent-entry-enabled="true"][data-view="work"] > .uw-split-resizer { display: block; grid-column: 2; grid-row: 1; width: 6px; cursor: col-resize; background: #121722; border-left: 1px solid #202736; border-right: 1px solid #1a202d; transition: background .15s ease; }
.uw-workspace[data-agent-entry-enabled="true"][data-view="work"] > .uw-split-resizer:hover, .uw-workspace[data-agent-entry-enabled="true"][data-view="work"] > .uw-split-resizer[data-dragging="true"] { background: #c8a96e; }
.uw-workspace[data-agent-entry-enabled="true"][data-view="work"][data-pane-layout="chat-max"]:has(> .uw-agent-entry > .uw-agent-chat) { grid-template-columns: minmax(0,1fr) !important; }
.uw-workspace[data-agent-entry-enabled="true"][data-view="work"][data-pane-layout="chat-max"] > .uw-split-resizer, .uw-workspace[data-agent-entry-enabled="true"][data-view="work"][data-pane-layout="chat-max"] > .uw-agent-live { display: none !important; }
.uw-workspace[data-agent-entry-enabled="true"][data-view="work"][data-pane-layout="live-max"]:has(> .uw-agent-entry > .uw-agent-chat) { grid-template-columns: minmax(0,1fr) !important; }
.uw-workspace[data-agent-entry-enabled="true"][data-view="work"][data-pane-layout="live-max"] > .uw-agent-entry, .uw-workspace[data-agent-entry-enabled="true"][data-view="work"][data-pane-layout="live-max"] > .uw-split-resizer { display: none !important; }
.uw-workspace[data-agent-entry-enabled="true"][data-view="work"][data-pane-layout="live-max"] > .uw-agent-live { grid-column: 1 !important; }
.uw-pane-header-right, .uw-pane-window-controls { display: inline-flex; align-items: center; gap: var(--sp-snug); flex: 0 0 auto; }
.uw-pane-btn { width: 30px; min-width: 30px; height: 30px; }
.uw-pane-btn[aria-pressed="true"] { border-color: #c8a96e; color: #f4dca9; background: #262117; }
.uw-pane-restore-pill { line-height: var(--lh-flat); min-height: 28px; padding: var(--sp-tight) var(--sp-cozy); border: 1px solid #8a734b; border-radius: 7px; background: #252017; color: #f0d7a1; font: inherit; font-size: var(--fs-micro); cursor: pointer; white-space: nowrap; }
.uw-pane-restore-pill:hover { border-color: #d8bb80; background: #30291c; }
.uw-agent-legacy[hidden], .uw-agent-chat-target[hidden] { display: none !important; }
.uw-agent-chat { display: flex; flex-direction: column; min-width: 0; min-height: 0; width: 100%; height: 100%; }
.uw-agent-chat-header { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-default); min-height: 52px; padding: var(--sp-cozy) var(--uw-page-gap); border-bottom: 1px solid #202634; background: linear-gradient(180deg,#111621,#0c1017); }
.uw-agent-chat-identity { display: flex; align-items: center; gap: var(--sp-default); min-width: 0; }
.uw-agent-chat-emblem { display: none; }
.uw-agent-chat-identity > div { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--sp-cozy); min-width: 0; }
.uw-agent-chat-identity strong { font-size: var(--fs-body); letter-spacing: 0; }
.uw-agent-chat-identity span:not(.uw-agent-chat-emblem) { font-size: var(--fs-micro); color: #969da8; }
.uw-agent-chat-connection { flex: 0 0 auto; display: inline-flex; align-items: center; gap: var(--sp-snug); padding: var(--sp-cozy) var(--sp-cozy); border: 1px solid #2f3747; border-radius: 12px; font-size: var(--fs-micro); color: #b9c2cf; background: #151a24; }
.uw-agent-chat-connection::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #6d747f; }
.uw-agent-chat-connection[data-state="connected"]::before { background: #6ee7b7; box-shadow: 0 0 8px #34d39966; }
.uw-agent-chat-scope { display: flex; align-items: center; gap: var(--sp-cozy); min-height: 36px; padding: var(--sp-cozy) var(--uw-page-gap); border-bottom: 1px solid #1e2533; background: #0e121b; font-size: var(--fs-micro); color: #9aa4b4; }
.uw-agent-chat-scope strong { min-width: 0; max-width: 58%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #e5ebf5; font-weight: var(--weight-semibold); }
.uw-chat-repo-switch-btn { margin-left: auto; line-height: var(--lh-flat); min-height: 26px; padding: var(--sp-tight) var(--sp-cozy); border: 1px solid #384359; border-radius: 6px; background: #161d2b; color: #dbe6f6; font: inherit; font-size: var(--fs-micro); cursor: pointer; white-space: nowrap; }
.uw-chat-repo-switch-btn:hover { border-color: #c8a96e; color: #f6e2b4; background: #242018; }
.uw-binding-toggle-btn { line-height: var(--lh-flat); min-height: 28px; padding: var(--sp-tight) var(--sp-cozy); border: 1px solid #5c503a; border-radius: 7px; background: #211d15; color: #eed59f; font: inherit; font-size: var(--fs-micro); font-weight: var(--weight-semibold); cursor: pointer; white-space: nowrap; }
.uw-binding-toggle-btn:hover, .uw-binding-toggle-btn[aria-expanded="true"] { border-color: #d6b475; background: #2e271a; color: #fff1cf; }
.uw-binding-drawer[hidden] { display: none !important; }
.uw-binding-drawer { display: grid; gap: var(--sp-cozy); max-height: 320px; overflow-y: auto; padding: var(--sp-default) var(--uw-page-gap); border-bottom: 1px solid #2b3548; background: linear-gradient(180deg,#121723,#0d111a); scrollbar-width: thin; }
.uw-binding-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-cozy); }
.uw-binding-head strong { font-size: var(--fs-label); color: #eef2f8; }
.uw-binding-notice { margin: 0; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #6b5a3c; border-radius: 7px; background: #231e15; color: #f3dcab; font-size: var(--fs-micro); line-height: var(--lh-normal); }
.uw-binding-columns { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-cozy); }
.uw-binding-card { display: grid; align-content: start; gap: var(--sp-cozy); padding: var(--sp-default); border: 1px solid #273042; border-radius: 9px; background: #101520; }
.uw-binding-desc { margin: 0; color: #9ea8b8; font-size: var(--fs-micro); line-height: var(--lh-normal); }
.uw-binding-channel-list, .uw-binding-session-list { display: grid; gap: var(--sp-cozy); }
.uw-binding-channel-btn { line-height: var(--lh-flat); min-height: 30px; padding: var(--sp-snug) var(--sp-cozy); border: 1px solid #323c50; border-radius: 7px; background: #171e2c; color: #dde5f2; font: inherit; font-size: var(--fs-micro); text-align: left; cursor: pointer; }
.uw-binding-channel-btn:hover { border-color: #b79b66; color: #f6e3b8; }
.uw-binding-channel-btn[aria-pressed="true"] { border-color: #d6b475; background: #292318; color: #f8e4b6; font-weight: var(--weight-semibold); }
.uw-binding-channel-btn[data-usable="false"] { opacity: .72; }
.uw-binding-session-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-cozy); padding: var(--sp-cozy); border: 1px solid #263042; border-radius: 7px; background: #141a27; }
.uw-binding-session-row > button { flex: 0 0 auto; white-space: nowrap; line-height: var(--lh-flat); padding: var(--sp-tight) var(--sp-cozy); font-size: var(--fs-micro); }
.uw-binding-session-copy { display: grid; gap: var(--sp-cozy); min-width: 0; flex: 1 1 auto; }
.uw-binding-session-copy strong { font-size: var(--fs-micro); color: #e6ecf5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uw-binding-session-copy small { font-size: var(--fs-micro); color: #95a0b2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uw-agent-chat-scope-dot { width: 5px; height: 5px; border-radius: 50%; background: #878b95; }
.uw-agent-chat-thread { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: var(--sp-roomy); padding: var(--sp-section) var(--uw-page-gap) var(--sp-band); scrollbar-color: #444850 transparent; scrollbar-width: thin; }
.uw-chat-announcement { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }
.uw-chat-welcome { width: 100%; max-width: 430px; margin: auto; padding-bottom: var(--sp-band); display: grid; justify-items: start; gap: var(--sp-default); }
.uw-chat-welcome-mark { font-size: var(--fs-view-title); color: #e5c687; line-height: var(--lh-flat); }
.uw-chat-welcome h2 { margin: 0; font-size: var(--fs-view-title); font-weight: var(--weight-semibold); line-height: var(--lh-display); letter-spacing: 0; }
.uw-chat-welcome p { max-width: 360px; margin: 0; font-size: var(--fs-entity-body); color: #a8b2c1; line-height: var(--lh-normal); }
.uw-chat-bubble { display: grid; gap: var(--sp-cozy); max-width: 92%; padding: var(--sp-roomy) var(--sp-roomy); border: 1px solid #262e3f; border-radius: 12px 14px 14px 4px; color: #e6eaf0; background: linear-gradient(160deg,#161b26,#121620); box-shadow: inset 0 1px 0 #ffffff08; }
.uw-chat-bubble-user { align-self: flex-end; border-color: #544731; border-radius: 12px 14px 4px 14px; background: linear-gradient(155deg,#2b251b,#1f1b14); }
.uw-chat-bubble-heading { display: flex; align-items: center; gap: var(--sp-cozy); font-size: var(--fs-label); }
.uw-chat-bubble-dot { width: 6px; height: 6px; border-radius: 50%; background: #858f9c; }
.uw-chat-bubble-user .uw-chat-bubble-dot { background: #e2c58b; }
.uw-chat-bubble p { margin: 0; font-size: var(--fs-entity-body); line-height: var(--lh-normal); white-space: pre-wrap; overflow-wrap: anywhere; }
.uw-chat-bubble[data-state="running"] .uw-chat-bubble-dot { background: #e8c582; box-shadow: 0 0 0 4px #e8c58218; animation: uw-live-beacon 1.8s ease-in-out infinite; }
.uw-chat-inline-heading { margin: var(--sp-snug) 0 var(--sp-hairline); font-size: var(--fs-label); letter-spacing: 0; color: #dec28c; font-weight: var(--weight-semibold); }
.uw-chat-options, .uw-chat-design-card { display: grid; gap: var(--sp-default); padding: var(--sp-roomy); border: 1px solid #283042; border-radius: 12px; background: linear-gradient(165deg,#141924,#0f131c); box-shadow: inset 0 1px 0 #ffffff08,0 10px 26px #00000045; }
.uw-chat-options-summary, .uw-chat-design-card p { margin: 0; font-size: var(--fs-label); line-height: var(--lh-normal); color: #b4bcc9; }
.uw-chat-option-list { display: grid; gap: var(--sp-cozy); }
.uw-chat-option { min-width: 0; display: grid; gap: var(--sp-snug); padding: var(--sp-default) var(--sp-default); text-align: left; border: 1px solid #2d3547; border-radius: 10px; background: #181e2b; color: #e7ebf2; cursor: pointer; transition: border-color .18s ease,background .18s ease,transform .18s ease; }
.uw-chat-option:hover, .uw-chat-option[aria-pressed="true"] { border-color: #d2b479; background: #262219; }
.uw-chat-option-top { display: flex; align-items: center; gap: var(--sp-cozy); font-size: var(--fs-entity-body); }
.uw-chat-option-letter { display: grid; place-items: center; width: 25px; height: 25px; border: 1px solid #6b7280; border-radius: 7px; color: #ebd097; }
.uw-chat-option-text, .uw-chat-option-note { font-size: var(--fs-micro); line-height: var(--lh-normal); color: #c0c7d4; }
.uw-chat-option-note { color: #949eae; }
.uw-chat-options-hint { margin: 0; color: #a8b1bf; font-size: var(--fs-micro); line-height: var(--lh-normal); }
.uw-chat-approval-list { display: flex; flex-wrap: wrap; gap: var(--sp-snug); }
.uw-chat-approval-list span { padding: var(--sp-cozy) var(--sp-cozy); border: 1px solid #2f384a; border-radius: 6px; font-size: var(--fs-micro); background: #19202d; }
.uw-chat-action-group { display: flex; flex-wrap: wrap; gap: var(--sp-cozy); align-items: center; }
.uw-chat-action { width: fit-content; min-height: 36px; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #d5b87e; border-radius: 8px; background: linear-gradient(180deg,#e9cd96,#cea765); color: #16130d; font-size: var(--fs-label); font-weight: var(--weight-semibold); cursor: pointer; box-shadow: 0 4px 14px #cfa86624; transition: filter .16s ease,box-shadow .16s ease; }
.uw-chat-action:hover { filter: brightness(1.06); box-shadow: 0 6px 18px #cfa86638; }
.uw-chat-action:disabled { background: #2b303c; border-color: #3c4252; color: #8e96a4; box-shadow: none; cursor: not-allowed; }
.uw-chat-secondary { width: fit-content; max-width: 100%; min-height: 36px; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #3c4558; border-radius: 8px; background: #1a202d; color: #e2e6ee; font: inherit; font-size: var(--fs-label); cursor: pointer; transition: border-color .16s ease,background .16s ease; }
.uw-chat-secondary:hover { border-color: #d2b479; color: #f8ecd4; background: #232732; }
.uw-chat-fasttrack { border-color: #9e8352; background: linear-gradient(180deg,#2a2419,#1e1a13); color: #f3dcad; }
.uw-chat-error { padding: var(--sp-cozy) var(--sp-cozy); border-left: 2px solid #d39976; background: #372723; color: #efd2c0 !important; overflow-wrap: anywhere; }
.uw-chat-recommendation { width: fit-content; padding: var(--sp-cozy) var(--sp-cozy); border: 1px solid #756346; border-radius: 5px; color: #d8bb84; font-size: var(--fs-micro); }
.uw-chat-review-details { border: 1px solid #42454c; border-radius: 9px; background: #1c1f23; color: #d8dce4; overflow: clip; }
.uw-chat-review-details > summary { padding: var(--sp-default); font-size: var(--fs-label); font-weight: var(--weight-semibold); cursor: pointer; }
.uw-chat-review-fields { display: grid; gap: 0; padding: 0 var(--sp-default) var(--sp-cozy); }
.uw-chat-review-field { display: grid; gap: var(--sp-snug); padding: var(--sp-cozy) 0; border-top: 1px solid #33363c; }
.uw-chat-review-field strong { font-size: var(--fs-micro); color: #cfba90; }
.uw-chat-review-field p { white-space: pre-wrap; color: #c9ced5; overflow-wrap: anywhere; }
.uw-agent-chat-target { display: flex; align-items: center; gap: var(--sp-cozy); margin: 0 var(--uw-page-gap); padding: var(--sp-cozy) var(--sp-default); border: 1px solid #8c7652; border-radius: 8px 8px 0 0; background: #29251d; color: #e6c78a; font-size: var(--fs-micro); }
.uw-agent-chat-target span { flex: 1; }
.uw-agent-chat-target button { flex: 0 0 auto; border: 0; background: transparent; color: #e6c78a; font-size: var(--fs-view-title); cursor: pointer; }
.uw-agent-entry form.uw-agent-chat-composer { display: grid; gap: var(--sp-cozy); margin: 0; padding: var(--sp-default) var(--uw-page-gap) var(--sp-section); border-top: 1px solid #2b2d32; background: #111215; }
.uw-agent-chat-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }
.uw-agent-chat-composer textarea { box-sizing: border-box; display: block; width: 100%; min-height: 68px; max-height: 164px; resize: vertical; border: 1px solid #4b4b4a; border-radius: 12px; padding: var(--sp-default) var(--sp-default); color: #f0f0f1; background: #202125; font: inherit; font-size: var(--fs-entity-body); line-height: var(--lh-snug); }
.uw-agent-chat-composer textarea:focus-visible { outline: 2px solid #bda478; outline-offset: 1px; }
.uw-agent-chat-composer textarea::placeholder { color: #9299a4; }
.uw-agent-chat-composer-bottom { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--sp-cozy); min-height: 36px; }
.uw-agent-chat-composer-bottom span { font-size: var(--fs-micro); line-height: var(--lh-snug); color: #9399a3; }
.uw-agent-chat-composer-bottom > [data-uw-chat-guidance] { margin-right: auto; }
.uw-chat-channel-picker { display: inline-flex; align-items: center; gap: var(--sp-cozy); min-width: 0; max-width: 58%; }
.uw-chat-channel-label { flex: 0 0 auto; font-size: var(--fs-micro); color: #b9c2d0; white-space: nowrap; }
.uw-chat-host-select { line-height: var(--lh-flat); min-width: 0; max-width: 215px; min-height: 30px; padding: var(--sp-tight) var(--sp-cozy); border: 1px solid #3c4557; border-radius: 7px; background: #191e2a; color: #e8edf5; font: inherit; font-size: var(--fs-micro); cursor: pointer; }
.uw-chat-host-select:hover { border-color: #b79b66; }
.uw-agent-chat-composer-bottom button { display: grid; place-items: center; flex: 0 0 34px; height: 34px; border: 1px solid #d4b97f; border-radius: 9px; background: #d7bd88; color: #171717; cursor: pointer; }
.uw-agent-chat-composer-bottom button:disabled { border-color: #3d4046; background: #2c2d30; color: #90959d; cursor: default; }
.uw-agent-chat-composer-bottom button .uw-icon { width: 18px; height: 18px; }
.uw-workspace[data-agent-entry-enabled="true"][data-view="work"] > .uw-agent-live { grid-column: 3; grid-row: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: radial-gradient(ellipse 72% 58% at 62% 0%,#c8a6681a,transparent 66%),radial-gradient(ellipse 52% 46% at 15% 100%,#3b82f610,transparent 72%),#080a0f; }
.uw-agent-live-header { display: flex; align-items: center; justify-content: flex-end; gap: var(--sp-default); min-height: 0; padding: var(--sp-cozy) var(--uw-page-gap) 0; border-bottom: 0; background: transparent; }
.uw-agent-live-title { display: none !important; }
.uw-agent-flow > .uw-live-view-kicker { display: none; }
.uw-agent-inventory-section:not([open]) > :not(summary) { display: none; }
.uw-agent-live-bar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-cozy); padding: var(--sp-cozy) var(--uw-page-gap); border-bottom: 1px solid #202634; }
.uw-agent-live-source { max-width: 48%; padding: var(--sp-cozy); border: 1px solid #303746; border-radius: 6px; color: #bcb9ad; background: #141923; font-size: var(--fs-micro); line-height: var(--lh-snug); text-align: right; }
.uw-agent-live-modes { display: flex; flex-wrap: wrap; gap: var(--sp-snug); padding: 0; border-bottom: 0; min-width: 0; }
.uw-agent-live-modes button { min-width: 0; padding: var(--sp-cozy) var(--sp-default); border: 1px solid transparent; border-radius: 8px; background: transparent; color: #9ba2ac; font: inherit; font-size: var(--fs-label); cursor: pointer; white-space: nowrap; }
.uw-agent-live-modes button[aria-selected="true"] { color: #f2e4c4; border-color: #6a593c; background: #262219; }
.uw-agent-live-modes button:hover { color: #f1f2f4; background: #1c222e; }
.uw-agent-docked-run-slot { position: relative; container: uw-run-slot / inline-size; flex: 1 1 auto; min-width: 0; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; background: #0a0f18; }
.uw-docked-run-meta { grid-column: 1 / -1; grid-row: 1; min-width: 0; border-bottom: 1px solid #222c3f; background: #0e1420; }
.uw-docked-run-meta:not([open]) > .uw-docked-run-meta-body { display: none; }
.uw-docked-run-meta-summary { line-height: var(--lh-flat); display: flex; align-items: center; justify-content: space-between; gap: var(--sp-cozy); min-height: 36px; padding: var(--sp-snug) var(--sp-default); list-style: none; cursor: pointer; color: #dce3ef; font-size: var(--fs-label); }
.uw-docked-run-meta-summary::-webkit-details-marker { display: none; }
.uw-docked-run-meta-title { min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--weight-semibold); }
.uw-docked-run-meta-actions { display: inline-flex; align-items: center; gap: var(--sp-cozy); flex: 0 0 auto; }
.uw-docked-switch-btn { line-height: var(--lh-flat); min-height: 26px; padding: var(--sp-tight) var(--sp-cozy); border: 1px solid #41506b; border-radius: 6px; background: #162032; color: #dbe6f6; font: inherit; font-size: var(--fs-micro); cursor: pointer; white-space: nowrap; }
.uw-docked-switch-btn:hover { border-color: #c8a96e; color: #f7e3b5; }
.uw-docked-meta-hint { color: #d8bb84; font-size: var(--fs-micro); white-space: nowrap; }
.uw-docked-run-meta-body { max-height: 210px; overflow-y: auto; border-top: 1px solid #1d2638; background: #0b1019; scrollbar-width: thin; }
.uw-agent-docked-run-slot > .graph-panel { grid-column: 1; grid-row: 2; display: flex !important; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; width: 100%; height: 100%; }
.uw-agent-docked-run-slot > .empty-state { grid-column: 1; grid-row: 2; margin: auto; }
.uw-agent-docked-run-slot .graph-stage { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; overflow: hidden; }
.uw-agent-docked-run-slot .graph-canvas { flex: 1 1 0 !important; height: auto !important; min-height: 280px !important; max-height: none !important; overflow: hidden !important; touch-action: none !important; }
.uw-agent-docked-run-slot .graph-precision-control, .uw-agent-docked-run-slot [data-live-graph-map], .uw-agent-docked-run-slot .graph-toolbar [data-evidence-toggle], .shell[data-unified-workspace="true"] .graph-toolbar [data-evidence-toggle] { display: inline-flex !important; }
.uw-agent-docked-run-slot .graph-minimap { display: block !important; }
.uw-agent-docked-run-slot > .evidence-panel { grid-column: 2; grid-row: 2; position: relative; width: 372px; min-height: 0; max-height: 100%; overflow: auto; border-left: 1px solid #263144; background: #111824; z-index: 20; }
.uw-agent-docked-run-slot > .evidence-panel[data-open="false"] { display: none !important; }
@container uw-run-slot (max-width: 1080px) { .uw-agent-docked-run-slot .stage-rail { display: grid !important; grid-template-columns: repeat(4, minmax(0, 1fr)) !important; gap: var(--sp-cozy) !important; } .uw-agent-docked-run-slot .graph-stage-bar { flex-wrap: wrap; gap: var(--sp-cozy); padding: var(--sp-cozy) var(--sp-default); } .uw-agent-docked-run-slot .graph-canvas-tools { flex: 1 1 auto; } }
@container uw-run-slot (max-width: 920px) { .uw-agent-docked-run-slot > .evidence-panel { position: absolute; top: 36px; right: 0; bottom: 0; width: min(372px, 90%); box-shadow: -14px 0 36px #000b; z-index: 26; } }
.uw-eight-stage-bar { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: var(--sp-cozy); margin: 0 0 var(--sp-default); }
.uw-eight-stage-chip { min-width: 0; display: flex; align-items: center; gap: var(--sp-snug); padding: var(--sp-cozy) var(--sp-cozy); border: 1px solid #283042; border-radius: 8px; background: #111621; color: #9aa4b5; font: inherit; font-size: var(--fs-micro); cursor: pointer; text-align: left; transition: border-color .16s ease,color .16s ease; }
.uw-eight-stage-chip:hover { border-color: #9e8455; color: #eef2f8; }
.uw-eight-stage-chip[data-state="completed"] { border-color: #2d5c4b; color: #a7f3d0; background: #10201b; }
.uw-eight-stage-chip[data-state="running"], .uw-eight-stage-chip[data-state="waiting_human"] { border-color: #d6a856; color: #f7dfaa; background: #241e13; }
.uw-eight-stage-num { font-variant-numeric: tabular-nums; color: #d5bb84; }
.uw-eight-stage-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uw-flow-dag-card { margin: 0 0 var(--sp-section); border: 1px solid #2a3346; border-radius: 11px; background: #0c1018; overflow: hidden; box-shadow: 0 10px 28px #0006; }
.uw-flow-dag-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--sp-cozy); padding: var(--sp-cozy) var(--sp-default); border-bottom: 1px solid #202838; background: linear-gradient(90deg,#161d2b,#101520); }
.uw-flow-dag-title { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--sp-cozy); }
.uw-flow-dag-title strong { font-size: var(--fs-label); color: #ebf0f7; }
.uw-flow-dag-title small { font-size: var(--fs-micro); color: #95a0b3; }
.uw-flow-dag-tools { display: inline-flex; align-items: center; flex-wrap: wrap; gap: var(--sp-snug); }
.uw-flow-dag-tool { line-height: var(--lh-flat); min-height: 28px; padding: var(--sp-tight) var(--sp-cozy); border: 1px solid #343d52; border-radius: 6px; background: #171e2b; color: #d6deeb; font: inherit; font-size: var(--fs-micro); cursor: pointer; white-space: nowrap; }
.uw-flow-dag-tool:hover { border-color: #c8a96e; color: #f6e2b5; }
.uw-flow-dag-primary { border-color: #8a734b; background: #262016; color: #f2daa4; }
.uw-flow-dag-scale { font-variant-numeric: tabular-nums; color: #dec28a; }
.uw-flow-dag-canvas { position: relative; max-height: 290px; overflow: auto; cursor: grab; background-color: #080b11; background-image: radial-gradient(#7d858f22 1px, transparent 1px); background-size: 22px 22px; scrollbar-width: thin; scrollbar-color: #464e5e transparent; }
.uw-flow-dag-canvas[data-panning="true"] { cursor: grabbing; }
.uw-flow-dag-canvas > svg { display: block; min-width: 100%; height: auto; }
.uw-agent-live-viewport { flex: 1 1 auto; min-width: 0; min-height: 0; overflow: auto; scrollbar-color: #3d4147 transparent; scrollbar-width: thin; background-image: radial-gradient(#8f918716 .8px, transparent .8px); background-size: 19px 19px; }
.uw-agent-live-footer { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-default); padding: var(--sp-default) var(--uw-page-gap); border-top: 1px solid #292c32; background: #121316; font-size: var(--fs-micro); color: #aab0ba; }
.uw-agent-live-footer span:first-child { min-width: 0; overflow-wrap: anywhere; }
.uw-agent-live-footer span:last-child { color: #d5bc86; white-space: nowrap; font-variant-numeric: tabular-nums; }
.uw-live-view-kicker { display: block; margin: 0 0 var(--sp-default); font-size: var(--fs-micro); color: #b4b8bf; letter-spacing: 0; }
.uw-agent-flow, .uw-agent-collaboration, .uw-agent-knowledge { width: min(100%,920px); margin: 0 auto; padding: var(--uw-page-gap) var(--uw-page-gap) var(--sp-band); }
.uw-agent-flow-nodes { list-style: none; display: grid; gap: var(--sp-roomy); padding: 0 0 0 var(--sp-section); margin: 0; }
.uw-agent-flow-row { position: relative; }
.uw-agent-flow-row:not(:last-child)::after { content: ''; position: absolute; left: 23px; top: calc(100% + 1px); bottom: -21px; border-left: 1px dashed #50515a; }
.uw-agent-flow-node { box-sizing: border-box; display: flex; align-items: center; gap: var(--sp-roomy); width: 100%; min-height: 88px; padding: var(--sp-default) var(--sp-roomy); border: 1px solid #40434b; border-radius: 11px; background: linear-gradient(110deg,#1a1c20,#141519); color: #e2e5ea; text-align: left; cursor: pointer; transition: border-color .2s ease,background .2s ease,box-shadow .2s ease; }
.uw-agent-flow-node:hover, .uw-agent-flow-node[data-selected="true"] { border-color: #d0b987; box-shadow: 0 0 0 2px #d0b98722; }
.uw-agent-flow-node[data-state="running"] { border-color: #d8b777; box-shadow: 0 0 0 2px #c0a46a1b,0 0 27px #c8a97218; background: linear-gradient(115deg,#2f291e,#1c1b19); }
.uw-agent-flow-index { flex: 0 0 44px; height: 44px; display: grid; place-items: center; border: 1px solid #5e6169; border-radius: 10px; color: #c2c5cc; background: #24262b; font-size: var(--fs-body); font-variant-numeric: tabular-nums; }
.uw-agent-flow-node[data-state="running"] .uw-agent-flow-index { color: #1c1913; border-color: #d6b77d; background: #d6b77d; animation: uw-live-beacon 2s ease-in-out infinite; }
.uw-agent-flow-copy { flex: 1; display: grid; gap: var(--sp-cozy); min-width: 0; }
.uw-agent-flow-copy strong { font-size: var(--fs-body); font-weight: var(--weight-semibold); }
.uw-agent-flow-copy small { font-size: var(--fs-micro); color: #989fa9; line-height: var(--lh-snug); }
.uw-agent-flow-status { font-size: var(--fs-micro); color: #a8afb9; white-space: nowrap; }
.uw-agent-flow-node[data-state="running"] .uw-agent-flow-status { color: #e7c68b; }
.uw-agent-flow-node[data-state="waiting_human"] .uw-agent-flow-status { color: #efb894; }
.uw-agent-flow-node[data-state="completed"] .uw-agent-flow-status { color: #c7ccd4; }
.uw-live-empty { display: grid; place-content: center; justify-items: center; gap: var(--sp-default); min-height: 400px; padding: var(--sp-band); text-align: center; }
.uw-live-empty-symbol { color: #957e56; font-size: var(--fs-view-title); line-height: var(--lh-flat); }
.uw-live-empty h3 { margin: 0; color: #e0e3e9; font-size: var(--fs-view-title); }
.uw-live-empty p { max-width: 310px; margin: 0; color: #969da8; font-size: var(--fs-label); line-height: var(--lh-normal); }
.uw-agent-knowledge-top { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-cozy); margin-bottom: var(--sp-default); }
.uw-agent-knowledge-layers { display: flex; flex-wrap: wrap; gap: var(--sp-snug); padding: 0 0 var(--sp-roomy); margin-bottom: var(--sp-default); border-bottom: 1px solid #30333a; }
.uw-agent-knowledge-layer { border: 1px solid #45474e; background: #202226; color: #aab0ba; border-radius: 8px; padding: var(--sp-cozy) var(--sp-default); font-size: var(--fs-micro); cursor: pointer; }
.uw-agent-knowledge-layer[aria-pressed="true"] { background: #333029; color: #eddbb5; border-color: #796746; }
.uw-agent-knowledge-layer:hover { color: #f3ead7; }
.uw-agent-knowledge-back { padding: var(--sp-cozy) var(--sp-cozy); border: 1px solid #444850; border-radius: 6px; background: #24262a; color: #cbd0d8; cursor: pointer; }
.uw-live-node-inspector { display: grid; gap: var(--sp-cozy); margin-top: var(--sp-roomy); padding: var(--sp-roomy); border: 1px solid #756447; border-radius: 10px; color: #d3d7de; background: #25231f; }
.uw-live-node-inspector p { margin: 0; font-size: var(--fs-label); line-height: var(--lh-normal); overflow-wrap: anywhere; }
.uw-live-node-note { border-left: 2px solid #ccac6f; padding-left: var(--sp-cozy); color: #f4d9a3; }
.uw-agent-knowledge .uw-knowledge-surface, .uw-agent-knowledge .uw-knowledge-graph[data-live-prd-knowledge-graph="module"] .uw-knowledge-surface { grid-template-columns: minmax(0,1fr); }
.uw-agent-knowledge .uw-knowledge-index { border-left: 0; border-top: 1px solid #303239; }
.uw-agent-knowledge .uw-knowledge-index-list { max-height: 220px; grid-template-columns: repeat(2,minmax(0,1fr)); }
.uw-agent-knowledge .uw-knowledge-canvas { max-height: none; min-height: 230px; }
.uw-agent-knowledge .uw-knowledge-map { display: flex; }
.uw-agent-knowledge .uw-kg-node[data-kind="architecture"] rect { stroke: #c9a96e; fill: #231f18; stroke-width: 1.4px; }
.uw-kg-node[data-state="completed"] rect, .uw-kg-node[data-state="accepted"] rect { stroke: #2f7a5e; fill: #11211c; }
.uw-kg-node[data-state="completed"] .uw-kg-node-state, .uw-kg-node[data-state="accepted"] .uw-kg-node-state { fill: #6ee7b7; }
.uw-kg-node[data-state="baseline"] rect { stroke: #60789c; fill: #141a24; }
.uw-kg-node-sub { fill: #93a0b4; font-size: var(--fs-micro); }
.uw-knowledge-graph[data-hide-containment="true"] .uw-kg-edge.contains { opacity: 0; pointer-events: none; }
.uw-agent-knowledge .uw-kg-node[data-state="running"] rect { stroke: #e8c582; fill: #2f281c; }
.uw-agent-knowledge-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-cozy); margin: 0 0 var(--sp-cozy); }
.uw-prd-completion-banner { display: grid; gap: var(--sp-cozy); margin: 0 0 var(--sp-default); padding: var(--sp-cozy) var(--sp-default); border: 1px solid #2b4740; border-radius: 9px; background: linear-gradient(90deg,#111e1b,#101622); }
.uw-prd-completion-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-cozy); }
.uw-prd-completion-top strong { font-size: var(--fs-label); color: #eef3fa; }
.uw-prd-completion-stat { font-size: var(--fs-micro); font-weight: var(--weight-semibold); color: #6ee7b7; font-variant-numeric: tabular-nums; }
.uw-prd-completion-track { height: 6px; border-radius: 6px; background: #1c2432; overflow: hidden; }
.uw-prd-completion-fill { display: block; height: 100%; border-radius: 6px; background: linear-gradient(90deg,#34d399,#d6b475); }
.uw-prd-status-pill { line-height: var(--lh-flat); padding: var(--sp-tight) var(--sp-cozy); border: 1px solid #354154; border-radius: 6px; background: #18202e; color: #ced7e6; font-size: var(--fs-micro); font-weight: var(--weight-semibold); white-space: nowrap; }
.uw-prd-status-pill[data-state="completed"], .uw-prd-status-pill[data-state="accepted"], .uw-prd-module-chip[data-state="completed"], .uw-prd-module-chip[data-state="accepted"] { border-color: #2f6c56; background: #11241e; color: #6ee7b7; }
.uw-prd-status-pill[data-state="running"] { border-color: #d6a856; background: #261f13; color: #f6dfaa; }
.uw-prd-status-pill[data-state="waiting_human"] { border-color: #d69e4e; background: #281e12; color: #f6c177; }
.uw-prd-tech-footnote { border-top: 1px solid #222938; padding-top: var(--sp-cozy); }
.uw-prd-tech-footnote > summary { cursor: pointer; font-size: var(--fs-micro); color: #8c98ab; }
.uw-prd-tech-footnote > p { margin: var(--sp-cozy) 0 0; font-size: var(--fs-micro); color: #96a3b8; line-height: var(--lh-normal); overflow-wrap: anywhere; }
.uw-prd-spec-inspector, .uw-prd-full-spec { display: grid; gap: var(--sp-default); margin-top: var(--sp-default); }
.uw-prd-spec-card { display: grid; gap: var(--sp-default); padding: var(--sp-roomy); border: 1px solid #313847; border-radius: 11px; background: linear-gradient(165deg,#141822,#0f1219); }
.uw-prd-spec-level1 { border-color: #6d5c3d; background: linear-gradient(165deg,#1b1915,#111319); }
.uw-prd-spec-card-head, .uw-prd-spec-section-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-cozy); }
.uw-prd-spec-title-group { display: grid; gap: var(--sp-cozy); min-width: 0; }
.uw-prd-spec-title-group h4 { margin: 0; font-size: var(--fs-entity-body); color: #eef2f8; line-height: var(--lh-snug); }
.uw-prd-level-badge { display: inline-flex; width: fit-content; line-height: var(--lh-flat); padding: var(--sp-tight) var(--sp-cozy); border: 1px solid #756343; border-radius: 6px; background: #292319; color: #edd5a3; font-size: var(--fs-micro); font-weight: var(--weight-semibold); }
.uw-prd-spec-meta, .uw-prd-spec-hint, .uw-prd-spec-summary { margin: 0; color: #9aa4b5; font-size: var(--fs-micro); line-height: var(--lh-normal); }
.uw-prd-spec-head-actions { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--sp-cozy); }
.uw-prd-spec-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--sp-cozy); }
.uw-prd-spec-field { display: grid; align-content: start; gap: var(--sp-cozy); min-width: 0; padding: var(--sp-default); border: 1px solid #252b38; border-radius: 8px; background: #0d1017; }
.uw-prd-spec-wide { grid-column: 1 / -1; }
.uw-prd-spec-field strong { color: #cfd7e6; font-size: var(--fs-micro); font-weight: var(--weight-semibold); }
.uw-prd-spec-field p { margin: 0; color: #b9c2d0; font-size: var(--fs-label); line-height: var(--lh-normal); overflow-wrap: anywhere; }
.uw-prd-spec-list { margin: 0; padding-left: var(--sp-roomy); display: grid; gap: var(--sp-snug); color: #b9c2d0; font-size: var(--fs-micro); line-height: var(--lh-normal); }
.uw-prd-layer-stack { display: grid; gap: var(--sp-snug); }
.uw-prd-layer-row { display: grid; grid-template-columns: minmax(148px,auto) minmax(0,1fr); align-items: center; gap: var(--sp-cozy); padding: var(--sp-cozy) var(--sp-default); border: 1px solid #262d3b; border-radius: 7px; background: #121620; }
.uw-prd-layer-tag { color: #e5ca93; font-size: var(--fs-micro); font-weight: var(--weight-semibold); }
.uw-prd-layer-chips { display: flex; flex-wrap: wrap; gap: var(--sp-snug); }
.uw-prd-module-chip { line-height: var(--lh-flat); padding: var(--sp-tight) var(--sp-cozy); border: 1px solid #384154; border-radius: 6px; background: #1a202e; color: #dce4f2; font: inherit; font-size: var(--fs-micro); cursor: pointer; }
button.uw-prd-module-chip:hover { border-color: #c9a96e; color: #f6e3ba; background: #26231c; }
.uw-prd-chip-downstream { border-color: #2f4f46; background: #13221f; color: #a7f3d0; }
.uw-prd-strategy-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(240px,1fr)); gap: var(--sp-default); }
.uw-prd-strategy-card { display: grid; align-content: start; gap: var(--sp-cozy); padding: var(--sp-default); border: 1px solid #353c4b; border-radius: 9px; background: #11151f; }
.uw-agent-collaboration-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-default); margin: var(--sp-cozy) 0; padding: var(--sp-roomy) var(--sp-roomy); border: 1px solid #3d3f45; border-radius: 10px; color: #bbc2ca; background: #1b1d21; font-size: var(--fs-label); }
.uw-agent-collaboration-row strong { font-size: var(--fs-entity-body); color: #e6e8ed; }
.uw-agent-collaboration-row span { flex: 1 1 180px; }
.uw-agent-collaboration-row[data-state="running"] { border-color: #b49a6e; }
/* One repository-backed capability inventory in the existing navigation. All
   runtime highlights require a currently selected, observed Run. */
.uw-agent-inventory { flex: 1 1 auto; min-height: 0; max-height: none; margin: var(--sp-cozy) 0 0; overflow: hidden; display: flex; flex-direction: column; border: 1px solid #252933; border-radius: 10px; background: #0d1016; }
.uw-agent-inventory-body { display: flex; flex-direction: column; gap: var(--sp-snug); min-width: 0; min-height: 0; flex: 1 1 auto; padding: var(--sp-cozy); overflow: hidden; }
.uw-agent-inventory-title { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-snug); padding: 0 var(--sp-snug); color: #dce0e4; }
.uw-agent-inventory-title strong { font-size: var(--fs-micro); font-weight: var(--weight-semibold); color: #eef1f6; }
.uw-inventory-flyout-trigger { line-height: var(--lh-flat); padding: var(--sp-hairline) var(--sp-snug); border: 1px solid #343b4a; border-radius: 5px; background: #161b25; color: #c7d0de; font: inherit; font-size: var(--fs-micro); cursor: pointer; }
.uw-inventory-flyout-trigger:hover { border-color: #b89b67; color: #f2dfb8; }
.uw-agent-inventory-search { line-height: var(--lh-flat); box-sizing: border-box; width: 100%; min-width: 0; min-height: 30px; margin: 0; padding: var(--sp-snug) var(--sp-cozy); border: 1px solid #333947; border-radius: 7px; background: #141821; color: #e4e6e9; font: inherit; font-size: var(--fs-micro); }
.uw-agent-inventory-search::placeholder { color: #9ca1a9; }
.uw-agent-inventory-search:focus-visible { outline: 2px solid #b89b67; outline-offset: 1px; }
.uw-agent-inventory-search-result { margin: 0; padding: 0 var(--sp-cozy); color: #b9bdc4; font-size: var(--fs-micro); }
.uw-agent-inventory-quicknav { position: static; flex: 1 1 auto; align-content: start; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-snug); padding: 0; background: transparent; border-bottom: 0; overflow-y: auto; scrollbar-width: thin; }
.uw-agent-inventory-shortcut, .uw-inventory-more-trigger { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-snug); width: 100%; line-height: var(--lh-flat); min-height: 28px; padding: var(--sp-tight) var(--sp-cozy); border: 1px solid transparent; border-radius: 6px; background: #141821; color: #cfd6e2; font: inherit; font-size: var(--fs-micro); cursor: pointer; text-align: left; }
.uw-inventory-shortcut-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uw-inventory-shortcut-count { flex: 0 0 auto; line-height: var(--lh-flat); padding: var(--sp-hairline) var(--sp-snug); border-radius: 5px; background: #222734; color: #e4eaf4; font-size: var(--fs-micro); font-variant-numeric: tabular-nums; font-weight: var(--weight-semibold); }
.uw-agent-inventory-shortcut:hover,.uw-agent-inventory-shortcut:focus-visible,.uw-agent-inventory-shortcut[aria-pressed="true"],.uw-inventory-more-trigger:hover,.uw-inventory-more-trigger[aria-pressed="true"] { border-color: #b89b67; background: #24211a; color: #f4e2bc; }
.uw-agent-inventory-body:not([data-flyout-open="true"]) > .uw-agent-inventory-flyout { display: none; }
.uw-agent-inventory-flyout { position: fixed; top: 56px; bottom: 0; left: var(--uw-nav-width, 176px); width: min(580px, calc(100vw - var(--uw-nav-width, 176px) - 16px)); z-index: 65; display: flex; flex-direction: column; gap: var(--sp-cozy); padding: var(--sp-roomy); border-right: 1px solid #3c4354; border-left: 1px solid #2d3342; background: linear-gradient(180deg,#11151e 0%,#0b0d13 100%); box-shadow: 22px 0 56px rgba(0,0,0,.74); overflow: hidden; }
.uw-inventory-flyout-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-cozy); padding-bottom: var(--sp-cozy); border-bottom: 1px solid #242a38; }
.uw-inventory-flyout-title { display: grid; gap: var(--sp-snug); min-width: 0; }
.uw-inventory-flyout-title strong { font-size: var(--fs-entity-body); color: #eef2f8; }
.uw-inventory-flyout-title small { color: #9aa4b5; font-size: var(--fs-micro); }
.uw-inventory-flyout-close { line-height: var(--lh-flat); padding: var(--sp-snug) var(--sp-default); border: 1px solid #434a59; border-radius: 7px; background: #1b202c; color: #e2e7f0; font: inherit; font-size: var(--fs-micro); cursor: pointer; }
.uw-inventory-flyout-close:hover { border-color: #c9a96e; color: #f5e2ba; }
.uw-inventory-flyout-tabs { display: flex; flex-wrap: wrap; gap: var(--sp-snug); padding-bottom: var(--sp-snug); border-bottom: 1px solid #202532; }
.uw-inventory-flyout-tab { line-height: var(--lh-flat); padding: var(--sp-tight) var(--sp-cozy); border: 1px solid #313847; border-radius: 6px; background: #161b26; color: #c4cddb; font: inherit; font-size: var(--fs-micro); cursor: pointer; }
.uw-inventory-flyout-tab[aria-pressed="true"], .uw-inventory-flyout-tab:hover { border-color: #b89b67; background: #2a241b; color: #f4dfb5; }
.uw-inventory-flyout-detail { display: grid; gap: var(--sp-cozy); padding: var(--sp-default); border: 1px solid #756343; border-radius: 9px; background: #1c1914; }
.uw-inventory-flyout-detail-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-cozy); }
.uw-inventory-flyout-detail-head strong { color: #f2dfb7; font-size: var(--fs-label); }
.uw-agent-inventory-sections { flex: 1 1 auto; min-height: 0; max-height: none; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #454954 transparent; display: flex; flex-direction: column; gap: var(--sp-cozy); padding-right: var(--sp-hairline); }
.uw-agent-inventory-section[data-flyout-filtered="true"] { display: none; }
.uw-inventory-card-grid, .uw-native-host-cap-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--sp-snug); padding: var(--sp-cozy); }
.uw-native-host-capability[data-selected="true"] { border-color: #d6b272; background: #2e271b; }
.uw-agent-inventory-section { min-width: 0; padding: var(--sp-hairline) 0; border-radius: 7px; }
.uw-agent-inventory-section[hidden] { display: none; }
.uw-agent-inventory-section[open] { background: #121314; }
.uw-agent-inventory-summary { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-snug); padding: var(--sp-cozy) var(--sp-default); color: #c9cdd3; font-size: var(--fs-micro); font-weight: var(--weight-semibold); cursor: pointer; }
.uw-agent-inventory-summary:hover { color: #f0f2f4; }
.uw-agent-inventory-summary:focus-visible,.uw-agent-inventory-agent:focus-visible,.uw-agent-inventory-capability:focus-visible,.uw-agent-runtime-card-heading:focus-visible { outline: 2px solid #dfc28b; outline-offset: -1px; }
.uw-agent-inventory-summary small { color: #a5aab2; background: #26282a; border-radius: 5px; padding: var(--sp-cozy); font-size: var(--fs-micro); font-variant-numeric: tabular-nums; }
.uw-agent-inventory-agent { box-sizing: border-box; width: 100%; min-height: 48px; display: flex; align-items: center; gap: var(--sp-cozy); padding: var(--sp-snug) var(--sp-default); text-align: left; border: 1px solid transparent; border-radius: 7px; background: transparent; color: #e0e3e7; font: inherit; cursor: pointer; }
.uw-agent-inventory-agent:hover { background: #202124; }
.uw-agent-inventory-agent[data-selected="true"],.uw-agent-inventory-agent[data-state="running"] { border-color: #b79d6e; background: #29251d; }
.uw-agent-inventory-registered { cursor: default; }
.uw-agent-inventory-registered:hover { background: transparent; }
.uw-agent-identity-mark { position: relative; display: grid; place-items: center; flex: 0 0 32px; width: 32px; height: 32px; border: 1px solid #545960; border-radius: 9px; background: #222528; color: #e4e5e6; font-size: var(--fs-micro); font-weight: var(--weight-semibold); letter-spacing: 0; }
.uw-agent-identity-mark::before { content: ''; position: absolute; inset: 4px; border: 1px solid #83878d50; border-radius: 5px; transform: rotate(-12deg); pointer-events: none; }
.uw-agent-identity-mark[data-identity="1"]::before { border-radius: 50%; transform: none; }
.uw-agent-identity-mark[data-identity="2"]::before { border-radius: 2px 9px 2px 9px; transform: rotate(12deg); }
[data-state="running"] > .uw-agent-identity-mark,[data-state="active"] > .uw-agent-identity-mark,.uw-agent-runtime-card[data-state="running"] .uw-agent-identity-mark,.uw-agent-runtime-card[data-state="active"] .uw-agent-identity-mark { border-color: #e2c084; color: #f5d9a8; box-shadow: 0 0 13px #d7b77b22; }
.uw-agent-inventory-agent-copy { display: grid; gap: var(--sp-cozy); min-width: 0; flex: 1; }
.uw-agent-inventory-agent-copy strong { font-size: var(--fs-micro); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uw-agent-inventory-agent-copy small { color: #a5a9b1; font-size: var(--fs-micro); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uw-agent-inventory-agent-copy .uw-agent-outcome-peek { color: #c7cbd1; display: -webkit-box; white-space: normal; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-height: var(--lh-snug); overflow: hidden; }
.uw-agent-inventory-hint,.uw-agent-inventory-footnote { margin: 0; padding: var(--sp-cozy) var(--sp-default); color: #999ea5; font-size: var(--fs-micro); line-height: var(--lh-normal); overflow-wrap: anywhere; }
.uw-agent-inventory-footnote { border-top: 1px solid #292b2f; }
.uw-native-host-controls { display: flex; justify-content: flex-end; padding: var(--sp-cozy) var(--sp-default); }
.uw-native-host-detect { padding: var(--sp-cozy) var(--sp-default); border: 1px solid #46484d; border-radius: 7px; color: #d6d8dc; background: #202124; font: inherit; font-size: var(--fs-micro); cursor: pointer; }
.uw-native-host-detect:hover,.uw-native-host-detect:focus-visible { border-color: #9d9d9d; background: #282a2f; }
.uw-native-host-detect:disabled { opacity: .55; cursor: wait; }
.uw-native-host { min-width: 0; margin: var(--sp-snug) var(--sp-cozy); border: 1px solid #35373b; border-radius: 9px; background: #1a1c1e; }
.uw-native-host[open] { border-color: #4a4c50; }
.uw-native-host-summary { display: flex; align-items: center; gap: var(--sp-cozy); padding: var(--sp-default); cursor: pointer; list-style-position: inside; }
.uw-native-host-summary:focus-visible { outline: 2px solid #dfc28b; outline-offset: -1px; }
.uw-native-host-identity { display: flex; align-items: center; flex: 1; min-width: 0; gap: var(--sp-cozy); }
.uw-native-host-mark { display: grid; place-items: center; flex: 0 0 30px; width: 30px; height: 30px; border: 1px solid #62666c; border-radius: 8px; background: #282a2d; color: #d8dce3; font-size: var(--fs-micro); font-weight: var(--weight-semibold); letter-spacing: 0; }
.uw-native-host-copy { display: grid; min-width: 0; gap: var(--sp-cozy); }
.uw-native-host-copy strong { font-size: var(--fs-label); color: #e4e7eb; overflow-wrap: anywhere; }
.uw-native-host-copy small { color: #a5aab2; font-size: var(--fs-micro); line-height: var(--lh-snug); overflow-wrap: anywhere; }
.uw-native-host-copy .uw-native-host-summary-counts { color: #c0c4ca; }
.uw-native-host-count { flex: 0 0 auto; color: #a6abb3; font-size: var(--fs-micro); white-space: nowrap; }
.uw-native-host-body { display: grid; gap: var(--sp-cozy); padding: var(--sp-cozy) var(--sp-default) var(--sp-default); border-top: 1px solid #35373b; }
.uw-native-host-access { display: grid; grid-template-columns: minmax(60px,auto) minmax(0,1fr); gap: var(--sp-cozy); align-items: baseline; padding: var(--sp-cozy); border-radius: 6px; background: #24262a; }
.uw-native-host-access span { color: #a6abb4; font-size: var(--fs-micro); }
.uw-native-host-access strong { min-width: 0; color: #d8dce1; font-size: var(--fs-micro); font-weight: var(--weight-semibold); overflow-wrap: anywhere; }
.uw-native-host-graph { justify-self: start; min-height: 28px; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #625843; border-radius: 6px; background: #28251f; color: #e9d3a6; font: inherit; font-size: var(--fs-micro); cursor: pointer; }
.uw-native-host-graph:hover,.uw-native-host-graph:focus-visible { border-color: #b89b67; background: #393124; }
.uw-native-host-capability-disclaimer { margin: 0; color: #aeb2ba; font-size: var(--fs-micro); line-height: var(--lh-normal); }
.uw-native-host-family { min-width: 0; padding: var(--sp-cozy); border-radius: 6px; background: #202226; }
.uw-native-host-family-summary { padding: var(--sp-cozy); color: #dadfe5; font-size: var(--fs-micro); font-weight: var(--weight-semibold); cursor: pointer; }
.uw-native-host-family-summary:focus-visible { outline: 2px solid #dfc28b; outline-offset: -1px; }
.uw-native-host-family:not([open]) > :not(summary) { display: none; }
.uw-native-host-family .uw-native-host-capability { margin-top: var(--sp-cozy); }
.uw-native-host-capability { display: grid; width: 100%; min-width: 0; gap: var(--sp-cozy); padding: var(--sp-cozy); border: 1px solid #373a40; border-radius: 5px; background: #25272b; text-align: left; font: inherit; cursor: pointer; }
.uw-native-host-capability:hover,.uw-native-host-capability:focus-visible { border-color: #b89b67; background: #30302d; outline-offset: -1px; }
.uw-native-host-capability span { color: #dee2e7; font-size: var(--fs-micro); overflow-wrap: anywhere; }
.uw-native-host-capability small { color: #a2a8b0; font-size: var(--fs-micro); line-height: var(--lh-snug); }
.uw-native-host-inspection { display: grid; gap: var(--sp-snug); }
.uw-native-host-inspection-row { display: grid; grid-template-columns: minmax(66px,auto) minmax(0,1fr); gap: var(--sp-default); padding: var(--sp-cozy) var(--sp-default); border-radius: 6px; background: #202225; }
.uw-native-host-inspection-row span { color: #afb5bf; font-size: var(--fs-micro); }
.uw-native-host-inspection-row strong { color: #e2e6ec; font-size: var(--fs-micro); font-weight: var(--weight-semibold); overflow-wrap: anywhere; }
.uw-native-host-candidates { margin: var(--sp-snug) var(--sp-cozy); border: 1px solid #31343a; border-radius: 7px; background: #17191b; }
.uw-native-host-candidates-summary { padding: var(--sp-default); color: #bfc5ce; font-size: var(--fs-micro); cursor: pointer; }
.uw-native-host-candidates-summary:focus-visible { outline: 2px solid #d4bd92; outline-offset: -1px; }
.uw-native-host-candidates-list { display: flex; flex-wrap: wrap; gap: var(--sp-cozy); padding: var(--sp-cozy) var(--sp-default) var(--sp-default); border-top: 1px solid #32363b; }
.uw-native-host-candidates-list span { padding: var(--sp-cozy); border: 1px solid #393c40; border-radius: 5px; color: #b8bec8; font-size: var(--fs-micro); }
.uw-agent-inventory-capability { width: 100%; display: grid; gap: var(--sp-cozy); min-width: 0; padding: var(--sp-cozy) var(--sp-default); border: 0; border-radius: 6px; background: transparent; color: #d8dce0; text-align: left; font: inherit; }
button.uw-agent-inventory-capability { cursor: pointer; }
button.uw-agent-inventory-capability:hover { background: #212326; }
.uw-agent-inventory-capability small { color: #a3a7ae; font-size: var(--fs-micro); }
.uw-agent-inventory-item-title { font-size: var(--fs-micro); overflow-wrap: anywhere; }
.uw-agent-inventory-capability[data-state="observed"] { border-left: 2px solid #b9bdc3; }
.uw-agent-inventory-capability[data-state="planned"] { border-left: 2px solid #6a6d73; }
.uw-agent-runtime-card { display: grid; gap: var(--sp-cozy); padding: var(--sp-roomy); margin: 0 0 var(--sp-default); border: 1px solid #3e4147; border-radius: 11px; background: #141517; }
.uw-agent-runtime-card[data-state="running"],.uw-agent-runtime-card[data-state="active"],.uw-agent-runtime-card[data-selected="true"] { border-color: #c9a96e; box-shadow: 0 0 0 1px #c9a96e20; }
.uw-agent-runtime-card-heading { width: 100%; display: flex; align-items: center; gap: var(--sp-default); justify-content: space-between; padding: 0; border: 0; background: transparent; color: #e1e4e7; font: inherit; text-align: left; cursor: pointer; }
.uw-agent-runtime-identity { display: flex; gap: var(--sp-default); align-items: center; min-width: 0; }
.uw-agent-runtime-copy { display: grid; min-width: 0; gap: var(--sp-snug); }
.uw-agent-runtime-copy strong { font-size: var(--fs-body); }
.uw-agent-runtime-copy small,.uw-agent-runtime-state { color: #a4abb5; font-size: var(--fs-micro); }
.uw-agent-runtime-state { flex: 0 0 auto; text-align: right; }
.uw-agent-runtime-task { margin: 0; color: #c7cbd3; font-size: var(--fs-label); line-height: var(--lh-normal); overflow-wrap: anywhere; }
.uw-agent-runtime-result { padding: var(--sp-default) var(--sp-default); border: 1px solid #34383e; border-radius: 8px; background: #1d1f21; }
.uw-agent-runtime-result strong { display: block; color: #dedfe1; font-size: var(--fs-label); }
.uw-agent-runtime-result p { margin: var(--sp-cozy) 0 0; color: #bec3cc; font-size: var(--fs-label); line-height: var(--lh-normal); overflow-wrap: anywhere; white-space: pre-wrap; }
.uw-agent-runtime-result small { color: #989ea7; font-size: var(--fs-micro); }
.uw-agent-runtime-result[data-level="reported"] { border-left: 2px solid #b3a38b; }
.uw-agent-runtime-result[data-level="absent"] { color: #9da3ae; }
.uw-agent-runtime-scope,.uw-agent-runtime-inspector-note { margin: 0; color: #aeb5bf; font-size: var(--fs-micro); line-height: var(--lh-normal); }
.uw-agent-runtime-capabilities { display: flex; gap: var(--sp-cozy); flex-wrap: wrap; padding-top: var(--sp-default); border-top: 1px solid #30343b; }
.uw-agent-runtime-capabilities p { color: #9fa6b0; font-size: var(--fs-micro); }
.uw-agent-runtime-capability-group { display: grid; align-content: start; gap: var(--sp-snug); flex: 1 1 160px; min-width: 0; }
.uw-agent-runtime-capability-group b { color: #dadde3; font-size: var(--fs-micro); }
.uw-agent-runtime-capability-group span { padding: var(--sp-cozy) var(--sp-cozy); border: 1px solid #363940; border-radius: 6px; background: #202226; color: #aeb6c1; font-size: var(--fs-micro); overflow-wrap: anywhere; }
@keyframes uw-live-beacon { 0%,100% { filter: brightness(1); } 50% { filter: brightness(1.22); } }
@media (max-width: 980px) { .uw-workspace[data-agent-entry-enabled="true"][data-view="work"]:has(> .uw-agent-entry > .uw-agent-chat) { grid-template-columns: minmax(290px, var(--uw-chat-share, 44%)) 6px minmax(330px, 1fr); }.uw-agent-chat-header,.uw-agent-live-header,.uw-agent-live-bar { padding-inline: var(--sp-roomy); }.uw-agent-chat-thread { padding-inline: var(--sp-roomy); }.uw-agent-entry form.uw-agent-chat-composer { padding-inline: var(--sp-roomy); }.uw-agent-live-modes button { padding-inline: var(--sp-cozy); } }
@media (max-width: 860px) { .shell[data-unified-workspace="true"]:has(.uw-workspace[data-agent-entry-enabled="true"]) { grid-template-columns: minmax(0,1fr); }.shell[data-unified-workspace="true"]:has(.uw-workspace[data-agent-entry-enabled="true"]) > .main { grid-column: 1; }.shell:has(.uw-workspace[data-agent-entry-enabled="true"]) .uw-navigation { display: none; }.shell:has(.uw-workspace[data-agent-entry-enabled="true"]) .uw-navigation[data-open="true"] { display: flex; position: absolute; inset: 56px auto 0 0; width: min(280px,86vw); z-index: 100; box-shadow: 14px 14px 72px #000d; }.shell:has(.uw-workspace[data-agent-entry-enabled="true"]) .uw-navigation-toggle { display: inline-flex; } }
@media (max-width: 720px) { .uw-workspace[data-agent-entry-enabled="true"][data-view="work"]:has(> .uw-agent-entry > .uw-agent-chat) { display: grid; grid-template-columns: minmax(0,1fr); grid-template-rows: minmax(350px,52vh) minmax(370px,48vh); overflow-y: auto; }.uw-workspace[data-agent-entry-enabled="true"][data-view="work"] > .uw-agent-entry { grid-column: 1; grid-row: 1; border-right: 0; border-bottom: 1px solid #303238; }.uw-workspace[data-agent-entry-enabled="true"][data-view="work"] > .uw-agent-live { grid-column: 1; grid-row: 2; min-height: 370px; }.uw-agent-chat-header,.uw-agent-live-header { min-height: 48px; padding: var(--sp-cozy) var(--sp-roomy); }.uw-agent-chat-scope { padding-inline: var(--sp-roomy); }.uw-agent-chat-thread { padding: var(--sp-roomy) var(--sp-roomy); }.uw-agent-entry form.uw-agent-chat-composer { padding: var(--sp-cozy) var(--sp-roomy) var(--sp-default); }.uw-agent-chat-composer textarea { min-height: 55px; }.uw-agent-live-modes { padding: var(--sp-cozy) var(--sp-default); }.uw-agent-flow,.uw-agent-collaboration,.uw-agent-knowledge { padding: var(--sp-roomy) var(--sp-default); }.uw-agent-flow-nodes { gap: var(--sp-default); padding-left: 0; }.uw-agent-flow-row:not(:last-child)::after { display: none; }.uw-agent-flow-node { min-height: 69px; }.uw-agent-flow-index { flex-basis: 34px; height: 34px; }.uw-live-empty { min-height: 250px; }.uw-agent-live-footer { padding: var(--sp-cozy) var(--sp-default); }.uw-agent-knowledge .uw-knowledge-index-list { grid-template-columns: 1fr; } }
.uw-cockpit-pillars { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--sp-cozy); margin: 0 0 var(--sp-section); }
.uw-cockpit-pillar { min-width: 0; display: grid; align-content: start; gap: var(--sp-snug); padding: var(--sp-default) var(--sp-default); border: 1px solid #283042; border-radius: 11px; background: linear-gradient(160deg,#151b26,#0f131c); color: #e5e9f0; text-align: left; font: inherit; cursor: pointer; box-shadow: inset 0 1px 0 #ffffff09,0 6px 18px #00000038; transition: border-color .18s ease,transform .18s ease,background .18s ease; }
.uw-cockpit-pillar:hover { border-color: #b79b66; background: linear-gradient(160deg,#1b2230,#121722); transform: translateY(-1px); }
.uw-cockpit-pillar[data-state="waiting_human"] { border-color: #d69e4e; background: linear-gradient(160deg,#281f13,#151310); box-shadow: 0 0 0 1px #d69e4e24,0 8px 22px #0000004a; }
.uw-cockpit-pillar[data-state="running"] { border-color: #dec082; background: linear-gradient(160deg,#262116,#141412); }
.uw-cockpit-pillar[data-state="completed"] { border-color: #2d5c4b; background: linear-gradient(160deg,#12241e,#0e1517); }
.uw-cockpit-pillar[data-state="blocked"] { border-color: #7c3843; background: linear-gradient(160deg,#29161b,#151115); }
.uw-cockpit-pillar-kicker { display: inline-flex; align-items: center; gap: var(--sp-snug); font-size: var(--fs-micro); font-weight: var(--weight-semibold); color: #d8bc84; letter-spacing: 0; }
.uw-cockpit-pillar[data-state="completed"] .uw-cockpit-pillar-kicker { color: #6ee7b7; }
.uw-cockpit-pillar[data-state="waiting_human"] .uw-cockpit-pillar-kicker { color: #f6c177; }
.uw-cockpit-pillar[data-state="blocked"] .uw-cockpit-pillar-kicker { color: #fda4af; }
.uw-cockpit-pillar-main { font-size: var(--fs-label); font-weight: var(--weight-semibold); color: #eef2f7; line-height: var(--lh-snug); word-break: keep-all; overflow-wrap: break-word; }
.uw-cockpit-pillar-sub { font-size: var(--fs-micro); color: #94a0b2; line-height: var(--lh-snug); word-break: keep-all; overflow-wrap: break-word; }
.uw-b4-card { display: grid; gap: var(--sp-default); margin-top: var(--sp-cozy); padding: var(--sp-roomy); border: 1px solid #354056; border-radius: 12px; background: linear-gradient(165deg,#151b27,#0e121b); box-shadow: inset 0 1px 0 #ffffff0a; }
.uw-b4-card[data-state="awaiting_human_b4"] { border-color: #c8a668; }
.uw-b4-card[data-state="accepted_and_integrated"] { border-color: #2f6853; }
.uw-b4-card[data-state="blocked"], .uw-b4-card[data-state="verification_failed"] { border-color: #823a46; }
.uw-b4-summary { margin: 0; font-size: var(--fs-label); color: #ced5e1; line-height: var(--lh-normal); }
.uw-b4-files, .uw-b4-checks, .uw-playbook-section { display: grid; gap: var(--sp-snug); }
.uw-b4-file-row { display: flex; align-items: center; gap: var(--sp-cozy); min-width: 0; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #262f40; border-radius: 7px; background: #10151f; font-size: var(--fs-micro); }
.uw-b4-file-tag { flex: 0 0 auto; padding: var(--sp-tight) var(--sp-cozy); border-radius: 4px; font-weight: var(--weight-semibold); background: #263144; color: #d6deeb; }
.uw-b4-file-tag[data-change="added"] { background: #132d24; color: #6ee7b7; }
.uw-b4-file-tag[data-change="modified"] { background: #2d2314; color: #f6c177; }
.uw-b4-file-tag[data-change="deleted"] { background: #31181e; color: #fda4af; }
.uw-b4-file-path { flex: 1 1 auto; min-width: 0; color: #e5eaf2; overflow-wrap: anywhere; }
.uw-b4-file-size { flex: 0 0 auto; color: #8e99ab; font-variant-numeric: tabular-nums; }
.uw-b4-check-row { display: grid; grid-template-columns: 18px minmax(110px,auto) minmax(0,1fr); align-items: baseline; gap: var(--sp-cozy); padding: var(--sp-cozy) var(--sp-default); border-radius: 7px; background: #121722; font-size: var(--fs-micro); }
.uw-b4-check-icon { font-weight: var(--weight-semibold); color: #6ee7b7; }
.uw-b4-check-row[data-passed="false"] .uw-b4-check-icon { color: #fda4af; }
.uw-b4-check-row strong { color: #dfe5ef; }
.uw-b4-check-row small { color: #9aa5b6; overflow-wrap: anywhere; }
.uw-b4-actions { display: flex; flex-wrap: wrap; gap: var(--sp-cozy); align-items: center; }
.uw-b4-accepted-banner { padding: var(--sp-cozy) var(--sp-default); border: 1px solid #2d6651; border-radius: 8px; background: #11261f; color: #86efac; font-size: var(--fs-label); font-weight: var(--weight-semibold); }
.uw-b4-rework-bar { display: flex; flex-wrap: wrap; gap: var(--sp-cozy); padding-top: var(--sp-cozy); border-top: 1px solid #252d3d; }
.uw-b4-rework-select, .uw-b4-rework-input { min-height: 36px; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #353e52; border-radius: 7px; background: #10141d; color: #e6eaf2; font: inherit; font-size: var(--fs-micro); }
.uw-b4-rework-input { flex: 1 1 180px; min-width: 0; }
.uw-playbook-card { display: grid; gap: var(--sp-cozy); padding: var(--sp-default); border: 1px solid #2c364a; border-radius: 9px; background: #121722; }
.uw-playbook-card[data-applicability="compatible"], .uw-playbook-card[data-applicability="sedimented"] { border-color: #2f6652; background: #101f1b; }
.uw-playbook-card[data-applicability="incompatible_context"] { border-color: #7c3843; background: #211318; }
.uw-playbook-card-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-cozy); }
.uw-playbook-card-top strong { font-size: var(--fs-label); color: #ebf0f7; }
.uw-playbook-badge { padding: var(--sp-cozy) var(--sp-cozy); border-radius: 6px; font-size: var(--fs-micro); background: #232c3d; color: #d5deec; }
.uw-playbook-card[data-applicability="compatible"] .uw-playbook-badge, .uw-playbook-card[data-applicability="sedimented"] .uw-playbook-badge { background: #15352a; color: #6ee7b7; }
.uw-playbook-card[data-applicability="incompatible_context"] .uw-playbook-badge { background: #381920; color: #fda4af; }
.uw-playbook-card small, .uw-playbook-lessons { margin: 0; font-size: var(--fs-micro); color: #a7b2c3; line-height: var(--lh-normal); overflow-wrap: anywhere; }
.uw-playbook-lesson-item { color: #ebd09b !important; }
.uw-subagent-run-jump { display: grid; gap: var(--sp-cozy); padding: var(--sp-cozy) var(--sp-default); border: 1px solid #594d37; border-radius: 8px; background: #211d15; color: #f0dfb8; font: inherit; text-align: left; cursor: pointer; }
.uw-subagent-run-jump:hover { border-color: #d6b475; background: #2c261b; }
.uw-subagent-run-jump strong { font-size: var(--fs-micro); color: #f6e5be; }
.uw-subagent-run-jump small { font-size: var(--fs-micro); color: #b6c0d1; }
.shell[data-unified-workspace="true"][data-work-view="repository"] .repository-view { height: 100%; min-height: 0; background: #080b11; }
.shell[data-unified-workspace="true"][data-work-view="repository"] .repository-layout { grid-template-columns: minmax(340px, 1.1fr) minmax(300px, .9fr); }
.uw-repo-live-panel { display: grid; gap: var(--sp-roomy); margin-bottom: var(--sp-roomy); }
.uw-repo-facts-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-cozy); }
.uw-repo-fact-cell { display: grid; align-content: start; gap: var(--sp-cozy); padding: var(--sp-default); border: 1px solid #263042; border-radius: 8px; background: #101622; }
.uw-repo-fact-cell span { font-size: var(--fs-micro); color: #96a2b5; }
.uw-repo-fact-cell strong { font-size: var(--fs-label); color: #ebf0f8; font-weight: var(--weight-semibold); line-height: var(--lh-normal); overflow-wrap: anywhere; }
.uw-repo-catalog-box { display: grid; gap: var(--sp-cozy); padding: var(--sp-default); border: 1px solid #2a3448; border-radius: 10px; background: #0e131e; }
.uw-repo-catalog-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-cozy); }
.uw-repo-catalog-head strong { font-size: var(--fs-label); color: #eef2f8; }
.uw-repo-chip-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(164px, 1fr)); gap: var(--sp-cozy); }
.uw-repo-chip { display: grid; align-content: start; gap: var(--sp-cozy); padding: var(--sp-cozy) var(--sp-default); border: 1px solid #2b3548; border-radius: 8px; background: #151c2a; color: #e2e8f2; font: inherit; text-align: left; cursor: pointer; transition: border-color .16s ease, background .16s ease; }
.uw-repo-chip:hover { border-color: #b79b66; background: #211f1a; }
.uw-repo-chip[data-selected="true"] { border-color: #d6b475; background: #292318; box-shadow: inset 2px 0 0 #d6b475; }
.uw-repo-chip strong { font-size: var(--fs-label); color: #f1f5fb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uw-repo-chip small { font-size: var(--fs-micro); color: #97a3b6; }
.uw-repo-temp-group { border-top: 1px solid #202838; padding-top: var(--sp-cozy); }
.uw-repo-temp-group > summary { cursor: pointer; font-size: var(--fs-micro); color: #9aa6b8; padding: var(--sp-cozy) 0; }
@media (max-width: 1120px) { .uw-cockpit-pillars { grid-template-columns: repeat(3, minmax(0, 1fr)); } .uw-eight-stage-bar { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (max-width: 720px) { .uw-workspace[data-agent-entry-enabled="true"][data-view="work"] > .uw-split-resizer { display: none !important; } .uw-workspace[data-agent-entry-enabled="true"][data-view="work"] > .uw-agent-live { grid-column: 1 !important; grid-row: 2 !important; } .uw-cockpit-pillars { grid-template-columns: repeat(2, minmax(0, 1fr)); } .uw-cockpit-pillar:last-child { grid-column: 1 / -1; } .uw-eight-stage-bar { grid-template-columns: repeat(2, minmax(0, 1fr)); } .uw-b4-check-row { grid-template-columns: 18px minmax(0, 1fr); } .uw-b4-check-row small { grid-column: 2; } }
@keyframes uw-atmosphere { 0% { transform: translateX(-8%) scale(.96); opacity: .55; } 100% { transform: translateX(16%) scale(1.08); opacity: 1; } }
@keyframes uw-ambient-field { 0% { background-position: 0 0; opacity: .55; } 100% { background-position: 100% 40%; opacity: 1; } }
@keyframes uw-radar-sweep { 0% { transform: translateY(-96px); opacity: 0; } 14% { opacity: .9; } 85% { opacity: .65; } 100% { transform: translateY(540px); opacity: 0; } }
@keyframes uw-graph-flow { to { stroke-dashoffset: -32; } }
@keyframes uw-idle-orbit { 0%,100% { opacity: .3; transform: rotate(-8deg) scale(.97); } 50% { opacity: .8; transform: rotate(8deg) scale(1.05); } }
.uw-wf-shell { display: grid; gap: var(--sp-cozy); padding: var(--sp-default); border: 1px solid #283246; border-radius: 12px; background: linear-gradient(165deg,#0f1522,#090d16); }
.uw-wf-shell[data-maximized="true"] { position: fixed; inset: var(--sp-roomy); z-index: 160; align-content: start; grid-template-rows: auto minmax(0,1fr) auto auto; box-shadow: 0 24px 80px #000e; }
.uw-wf-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-cozy); padding-bottom: var(--sp-cozy); border-bottom: 1px solid #1e293b; }
.uw-wf-crumbs, .uw-wf-cam-tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-cozy); }
.uw-wf-crumb-root { padding: var(--sp-cozy) var(--sp-default); border: 1px solid #c8a668; border-radius: 6px; background: #262015; color: #f6e5be; font: inherit; font-size: var(--fs-micro); font-weight: var(--weight-semibold); cursor: pointer; }
.uw-wf-crumb-sep { color: #64748b; font-size: var(--fs-micro); }
.uw-wf-crumb-sub { padding: var(--sp-cozy) var(--sp-default); border: 1px solid #38bdf866; border-radius: 6px; background: #0c2438; color: #7dd3fc; font-size: var(--fs-micro); font-weight: var(--weight-semibold); }
.uw-wf-gate-pill { padding: var(--sp-cozy) var(--sp-default); border: 1px solid #f59e0b66; border-radius: 6px; background: #2e1d09; color: #fde68a; font-size: var(--fs-micro); font-weight: var(--weight-semibold); }
.uw-wf-gate-pill[data-all-confirmed="true"] { border-color: #10b98166; background: #0b2920; color: #86efac; }
.uw-wf-surface { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-default); }
.uw-wf-shell[data-maximized="true"] .uw-wf-surface, .uw-workspace[data-pane-layout="live-max"] .uw-wf-surface { grid-template-columns: minmax(0, 1.65fr) minmax(336px, 0.95fr); min-height: 440px; }
.uw-wf-shell[data-maximized="true"] .uw-wf-surface { height: 100%; min-height: 480px; }
.uw-wf-canvas-wrap { position: relative; height: 304px; min-height: 304px; border: 1px solid #1e293b; border-radius: 10px; background-color: #070b13; background-image: radial-gradient(#94a3b82e 1px, transparent 1px); background-size: 18px 18px; overflow: hidden; cursor: grab; touch-action: none; }
.uw-wf-shell[data-maximized="true"] .uw-wf-canvas-wrap, .uw-workspace[data-pane-layout="live-max"] .uw-wf-canvas-wrap { height: 100%; min-height: 440px; }
.uw-wf-canvas-wrap:active { cursor: grabbing; }
.uw-wf-svg { width: 100%; height: 100%; display: block; }
.uw-wf-wire-anim { stroke-dasharray: 7 5; animation: uw-graph-flow 1.1s linear infinite; }
.uw-wf-node { cursor: pointer; }
.uw-wf-node:hover { filter: brightness(1.12); }
.uw-wf-edge-plus { cursor: pointer; opacity: .82; }
.uw-wf-edge-plus:hover { opacity: 1; filter: drop-shadow(0 0 6px #38bdf8aa); }
.uw-wf-toast { position: absolute; top: var(--sp-cozy); left: var(--sp-cozy); right: var(--sp-cozy); padding: var(--sp-cozy) var(--sp-default); border: 1px solid #f59e0b88; border-radius: 8px; background: #1c160be6; color: #fde68a; font-size: var(--fs-micro); font-weight: var(--weight-semibold); pointer-events: none; }
.uw-wf-minimap { position: absolute; left: var(--sp-cozy); bottom: var(--sp-cozy); padding: var(--sp-cozy); border: 1px solid #263246; border-radius: 7px; background: #080c15eb; pointer-events: none; }
.uw-wf-legend { position: absolute; right: var(--sp-cozy); bottom: var(--sp-cozy); display: flex; flex-wrap: wrap; gap: var(--sp-cozy); padding: var(--sp-cozy) var(--sp-default); border: 1px solid #1e293b; border-radius: 6px; background: #080c15eb; font-size: var(--fs-micro); color: #cbd5e1; pointer-events: none; }
.uw-wf-legend-item::before { content: "● "; }
.uw-wf-legend-item.done::before { color: #34d399; }
.uw-wf-legend-item.pending::before { color: #fbbf24; }
.uw-wf-legend-item.parallel::before { color: #38bdf8; }
.uw-wf-inspector { display: flex; flex-direction: column; min-width: 0; border: 1px solid #253044; border-radius: 10px; background: #101623; overflow: hidden; }
.uw-wf-insp-tabs { display: flex; gap: var(--sp-cozy); padding: var(--sp-cozy); border-bottom: 1px solid #1f293d; background: #0b101b; }
.uw-wf-insp-tab { flex: 1 1 0; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #263248; border-radius: 6px; background: #131b2b; color: #94a3b8; font: inherit; font-size: var(--fs-micro); font-weight: var(--weight-semibold); cursor: pointer; white-space: nowrap; }
.uw-wf-insp-tab[aria-pressed="true"] { border-color: #c8a668; background: #262015; color: #f6e5be; }
.uw-wf-insp-body { flex: 1 1 auto; display: grid; align-content: start; gap: var(--sp-cozy); padding: var(--sp-default); overflow-x: hidden; overflow-y: auto; }
.uw-wf-insp-title-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-cozy); }
.uw-wf-insp-title-row strong { flex: 1 1 160px; font-size: var(--fs-label); color: #f1f5f9; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uw-wf-badge-ok, .uw-wf-badge-warn { flex: 0 0 auto; padding: var(--sp-cozy) var(--sp-default); border-radius: 5px; font-size: var(--fs-micro); font-weight: var(--weight-semibold); white-space: nowrap; }
.uw-wf-badge-ok { background: #0c2d22; color: #6ee7b7; border: 1px solid #10b98155; }
.uw-wf-badge-warn { background: #331e09; color: #fcd34d; border: 1px solid #f59e0b66; }
.uw-wf-wireframe { display: grid; gap: var(--sp-cozy); }
.uw-wf-source-tag { padding: var(--sp-cozy) var(--sp-default); border-radius: 5px; font-size: var(--fs-micro); background: #162032; color: #93c5fd; border: 1px solid #283852; }
.uw-wf-source-model { background: #102a24; color: #6ee7b7; border-color: #10b98166; }
.uw-wf-mockup-img { width: 100%; max-height: 196px; object-fit: cover; border-radius: 8px; border: 1px solid #334155; display: block; }
.uw-wf-mock-window { display: grid; gap: var(--sp-cozy); padding: var(--sp-cozy); border: 1px solid #334155; border-radius: 8px; background: #090d16; }
.uw-wf-mock-winbar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-cozy); padding-bottom: var(--sp-cozy); border-bottom: 1px solid #1e293b; font-size: var(--fs-micro); }
.uw-wf-mock-wintitle { color: #f8fafc; font-weight: var(--weight-semibold); }
.uw-wf-mock-winbadge { padding: var(--sp-cozy) var(--sp-default); border-radius: 4px; background: #172554; color: #93c5fd; font-size: var(--fs-micro); }
.uw-wf-mock-cols { display: grid; gap: var(--sp-cozy); }
.uw-wf-mock-cols.uw-wf-mock-dual { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.uw-wf-mock-pane { display: grid; gap: var(--sp-cozy); padding: var(--sp-cozy); border: 1px solid #1e293b; border-radius: 6px; background: #0f172a; }
.uw-wf-mock-pane-accent { border-color: #38bdf855; background: linear-gradient(160deg,#0f1d33,#0f172a); }
.uw-wf-mock-pane strong { font-size: var(--fs-micro); color: #e2e8f0; }
.uw-wf-mock-pane small { font-size: var(--fs-micro); color: #94a3b8; line-height: var(--lh-snug); }
.uw-wf-mock-pills { display: flex; flex-wrap: wrap; gap: var(--sp-cozy); }
.uw-wf-mock-pill { padding: var(--sp-cozy) var(--sp-default); border-radius: 4px; background: #162032; color: #cbd5e1; font-size: var(--fs-micro); }
.uw-wf-mock-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-cozy); padding-top: var(--sp-cozy); border-top: 1px solid #1e293b; font-size: var(--fs-micro); }
.uw-wf-mock-hint { color: #94a3b8; }
.uw-wf-mock-cta { padding: var(--sp-cozy) var(--sp-default); border-radius: 5px; background: #065f46; color: #a7f3d0; font-weight: var(--weight-semibold); white-space: nowrap; }
.uw-wf-fb-row { display: flex; flex-wrap: wrap; gap: var(--sp-cozy); align-items: center; }
.uw-wf-fb-input, .uw-wf-quick-input, .uw-wf-textarea { min-width: 0; padding: var(--sp-cozy) var(--sp-default); border: 1px solid #2e3a52; border-radius: 7px; background: #0a0f1a; color: #f1f5f9; font: inherit; font-size: var(--fs-micro); }
.uw-wf-fb-input { flex: 1 1 180px; }
.uw-wf-quick-input { flex: 1 1 200px; }
.uw-wf-confirm-btn { width: 100%; padding: var(--sp-cozy) var(--sp-default); border-radius: 8px; font: inherit; font-size: var(--fs-micro); font-weight: var(--weight-semibold); cursor: pointer; }
.uw-wf-confirm-btn.pending { border: 1px solid #10b981; background: #10b981; color: #051b14; }
.uw-wf-confirm-btn.confirmed { border: 1px solid #10b98177; background: #0b2920; color: #6ee7b7; }
.uw-wf-no-ui-box, .uw-wf-edit-wrap { display: grid; gap: var(--sp-cozy); font-size: var(--fs-micro); color: #cbd5e1; }
.uw-wf-no-ui-box p { margin: 0; line-height: var(--lh-normal); }
.uw-wf-no-ui-box small, .uw-wf-field-label { color: #94a3b8; font-size: var(--fs-micro); }
.uw-wf-edit-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-cozy); }
.uw-wf-action-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-cozy); padding-top: var(--sp-cozy); border-top: 1px solid #1e293b; }
.uw-wf-act-btn { padding: var(--sp-cozy) var(--sp-default); border: 1px solid #334155; border-radius: 7px; background: #151e2e; color: #e2e8f0; font: inherit; font-size: var(--fs-micro); font-weight: var(--weight-semibold); cursor: pointer; white-space: nowrap; }
.uw-wf-act-btn:hover:not(:disabled) { border-color: #94a3b8; }
.uw-wf-act-parallel { border-color: #38bdf866; background: #0c2338; color: #7dd3fc; }
.uw-wf-act-ui { border-color: #f59e0b66; background: #2c1c09; color: #fcd34d; }
.uw-wf-act-danger { border-color: #f43f5e66; background: #2d1219; color: #fda4af; }
.uw-wf-act-muted { color: #94a3b8; }
.uw-wf-full-btn { width: 100%; }
.uw-wf-module-strip { display: flex; flex-wrap: wrap; gap: var(--sp-cozy); padding-top: var(--sp-cozy); }
@media (max-width: 1080px) { .uw-wf-surface { grid-template-columns: minmax(0, 1fr); } }
@media (prefers-reduced-motion: reduce) { .uw-skeleton span { animation: none !important; }.uw-overview::before, .uw-body::before, .uw-knowledge-canvas::before, .uw-empty-mark::after, .uw-kg-edge[data-activity="observed-running"], .uw-wf-wire-anim, .uw-agent-live-pulse, .uw-chat-bubble-dot, .uw-agent-flow-index { animation: none !important; }.uw-workspace *, .uw-navigation * { scroll-behavior: auto !important; transition-duration: 0s !important; } }
`;
