#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::DialogExt;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Deserialize)]
struct AgentLaunchReceipt {
    url: Option<String>,
}

struct BackendSupervisor {
    child: Mutex<Option<Child>>,
    current_url: Mutex<Option<String>>,
    project_root: Mutex<PathBuf>,
    repo_root: PathBuf,
    quitting: AtomicBool,
    /// Incremented on every connect request. Only the newest generation may
    /// own the backend child, navigate the window or show a boot error.
    generation: AtomicU64,
}

impl BackendSupervisor {
    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    fn stop_child(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut proc) = guard.take() {
                let _ = proc.kill();
                let _ = proc.wait();
            }
        }
    }
}

fn state_file_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;
    Some(base.join("Meta_Kim").join("desktop-last-project.txt"))
}

fn load_saved_project() -> Option<PathBuf> {
    let file = state_file_path()?;
    let raw = fs::read_to_string(file).ok()?;
    let candidate = PathBuf::from(raw.trim());
    if candidate.is_dir() {
        Some(candidate)
    } else {
        None
    }
}

fn save_last_project(project: &Path) {
    if let Some(file) = state_file_path() {
        if let Some(parent) = file.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(file, project.to_string_lossy().as_bytes());
    }
}

fn is_repo_root(dir: &Path) -> bool {
    dir.join("scripts").join("meta-kim-agent.mjs").is_file() && dir.join("package.json").is_file()
}

fn discover_repo_root() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("META_KIM_REPO_ROOT") {
        let candidate = PathBuf::from(explicit);
        if is_repo_root(&candidate) {
            return Some(candidate);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cursor = exe.parent();
        while let Some(dir) = cursor {
            if is_repo_root(dir) {
                return Some(dir.to_path_buf());
            }
            cursor = dir.parent();
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let mut cursor: Option<&Path> = Some(cwd.as_path());
        while let Some(dir) = cursor {
            if is_repo_root(dir) {
                return Some(dir.to_path_buf());
            }
            cursor = dir.parent();
        }
    }
    #[cfg(debug_assertions)]
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(root) = manifest_dir.parent().and_then(Path::parent) {
            if is_repo_root(root) {
                return Some(root.to_path_buf());
            }
        }
    }
    None
}

fn resolve_initial_project(repo_root: &Path) -> PathBuf {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--project-root" {
            if let Some(val) = args.next() {
                let path = PathBuf::from(val);
                if path.is_dir() {
                    return path;
                }
            }
        } else if !arg.starts_with('-') {
            let path = PathBuf::from(&arg);
            if path.is_dir() {
                return path;
            }
        }
    }
    load_saved_project().unwrap_or_else(|| repo_root.to_path_buf())
}

fn is_trusted_loopback_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    let port_part = rest.split(['/', '?', '#']).next().unwrap_or("");
    matches!(port_part.parse::<u16>(), Ok(port) if port >= 1024)
}

fn show_boot_error(app: &AppHandle, message: &str) {
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(encoded) = serde_json::to_string(message) {
            let js = format!(
                "if(window.__showBootError){{window.__showBootError({});}}",
                encoded
            );
            let _ = win.eval(&js);
        }
    }
}

fn navigate_main_window(app: &AppHandle, url: &str, project: &Path) {
    if !is_trusted_loopback_url(url) {
        show_boot_error(app, "安全校验拦截：回环服务地址不在 127.0.0.1 授信范围内。");
        return;
    }
    if let Some(win) = app.get_webview_window("main") {
        let project_name = project
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Workspace");
        let _ = win.set_title(&format!("Meta_Kim · {}", project_name));
        if let Ok(encoded) = serde_json::to_string(url) {
            let _ = win.eval(&format!("window.location.replace({});", encoded));
        }
    }
}

/// Shows a boot error only if this connect attempt is still the newest one,
/// so a superseded attempt can never cover the result of a later reconnect.
fn show_boot_error_if_current(
    app: &AppHandle,
    state: &BackendSupervisor,
    generation: u64,
    message: &str,
) {
    if state.is_current(generation) && !state.quitting.load(Ordering::SeqCst) {
        show_boot_error(app, message);
    }
}

fn spawn_and_connect(app: AppHandle, state: Arc<BackendSupervisor>, project_dir: PathBuf) {
    // Taken on the caller's thread so generations follow click order.
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    thread::spawn(move || {
        state.stop_child();
        let entry = state.repo_root.join("scripts").join("meta-kim-agent.mjs");
        if !entry.is_file() {
            show_boot_error_if_current(
                &app,
                &state,
                generation,
                "未找到 Meta_Kim 启动脚本（scripts/meta-kim-agent.mjs）。桌面客户端需要在完整的 Meta_Kim 仓库检出中运行：请把客户端放在 Meta_Kim 目录内，或设置 META_KIM_REPO_ROOT 指向该检出。",
            );
            return;
        }

        let mut cmd = Command::new("node");
        cmd.arg(&entry)
            .arg("--project-root")
            .arg(&project_dir)
            .arg("--port")
            .arg("0")
            .arg("--no-open")
            .arg("--json")
            .current_dir(&state.repo_root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_remove("CODEX_TOKEN")
            .env_remove("OPENAI_API_KEY")
            .env_remove("CODEX_THREAD_ID");

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = match cmd.spawn() {
            Ok(proc) => proc,
            Err(err) => {
                show_boot_error_if_current(
                    &app,
                    &state,
                    generation,
                    &format!(
                        "无法启动本机 Node.js 运行时（{}）。请确认系统已安装 Node.js {}。",
                        err,
                        env!("META_KIM_NODE_ENGINE")
                    ),
                );
                return;
            }
        };

        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                show_boot_error_if_current(
                    &app,
                    &state,
                    generation,
                    "本机治理服务未返回标准输出管道。",
                );
                return;
            }
        };

        // Claim the child slot under the lock. A superseded attempt stops its
        // own backend instead of replacing (or racing with) the newer one.
        match state.child.lock() {
            Ok(mut guard) if state.is_current(generation) => {
                if let Some(mut previous) = guard.take() {
                    let _ = previous.kill();
                    let _ = previous.wait();
                }
                *guard = Some(child);
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        }
        if let Ok(mut proj_guard) = state.project_root.lock() {
            *proj_guard = project_dir.clone();
        }
        save_last_project(&project_dir);

        let reader = BufReader::new(stdout);
        let mut launched = false;
        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if !trimmed.starts_with('{') {
                continue;
            }
            if !state.is_current(generation) {
                return;
            }
            if let Ok(receipt) = serde_json::from_str::<AgentLaunchReceipt>(trimmed) {
                if let Some(url) = receipt.url {
                    if is_trusted_loopback_url(&url) {
                        if let Ok(mut url_guard) = state.current_url.lock() {
                            *url_guard = Some(url.clone());
                        }
                        navigate_main_window(&app, &url, &project_dir);
                        launched = true;
                        break;
                    }
                }
            }
        }

        if !launched {
            show_boot_error_if_current(
                &app,
                &state,
                generation,
                "本机治理引擎未能建立 127.0.0.1 回环端口，请确认所选文件夹有效且未被权限策略拦截。",
            );
        }
    });
}

const RELEASE_SURFACE_GUARD_JS: &str = r#"(() => {
  if (window.__metaKimDesktopGuardApplied) return;
  window.__metaKimDesktopGuardApplied = true;
  document.addEventListener("contextmenu", (e) => {
    const tag = (e.target && e.target.tagName || "").toUpperCase();
    if (tag !== "TEXTAREA" && tag !== "INPUT") e.preventDefault();
  }, { capture: true });
  document.addEventListener("keydown", (e) => {
    const key = String(e.key || "").toUpperCase();
    const ctrlOrMeta = e.ctrlKey || e.metaKey;
    if (key === "F12"
      || (ctrlOrMeta && e.shiftKey && (key === "I" || key === "J" || key === "C"))
      || (ctrlOrMeta && key === "U")) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, { capture: true });
})();"#;

fn main() {
    let repo_root = discover_repo_root().unwrap_or_else(|| {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    });
    let initial_project = resolve_initial_project(&repo_root);

    let supervisor = Arc::new(BackendSupervisor {
        child: Mutex::new(None),
        current_url: Mutex::new(None),
        project_root: Mutex::new(initial_project.clone()),
        repo_root,
        quitting: AtomicBool::new(false),
        generation: AtomicU64::new(0),
    });

    let supervisor_setup = Arc::clone(&supervisor);
    let supervisor_window = Arc::clone(&supervisor);
    let supervisor_exit = Arc::clone(&supervisor);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .on_page_load(|webview, payload| {
            if !cfg!(debug_assertions) && payload.event() == PageLoadEvent::Finished {
                let _ = webview.eval(RELEASE_SURFACE_GUARD_JS);
            }
        })
        .setup(move |app| {
            let show_item = MenuItem::with_id(app, "show", "打开 Meta_Kim 主窗口", true, None::<&str>)?;
            let switch_item = MenuItem::with_id(
                app,
                "switch_project",
                "切换本地项目文件夹…",
                true,
                None::<&str>,
            )?;
            let reconnect_item = MenuItem::with_id(app, "reconnect", "重新连接后台引擎", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(
                app,
                "quit",
                "彻底退出（停止 24h 后台值班）",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&show_item, &switch_item, &reconnect_item, &sep, &quit_item])?;

            let sup_menu = Arc::clone(&supervisor_setup);
            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Meta_Kim · 智能体治理与 24h 后台值班")
                .show_menu_on_left_click(false)
                .on_menu_event(move |app_handle, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(win) = app_handle.get_webview_window("main") {
                            let _ = win.unminimize();
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "switch_project" => {
                        let handle = app_handle.clone();
                        let sup = Arc::clone(&sup_menu);
                        thread::spawn(move || {
                            if let Some(picked) = handle.dialog().file().blocking_pick_folder() {
                                if let Ok(path) = picked.into_path() {
                                    if let Some(win) = handle.get_webview_window("main") {
                                        let _ = win.unminimize();
                                        let _ = win.show();
                                        let _ = win.set_focus();
                                    }
                                    spawn_and_connect(handle, sup, path);
                                }
                            }
                        });
                    }
                    "reconnect" => {
                        let current = sup_menu
                            .project_root
                            .lock()
                            .map(|p| p.clone())
                            .unwrap_or_else(|_| sup_menu.repo_root.clone());
                        spawn_and_connect(app_handle.clone(), Arc::clone(&sup_menu), current);
                    }
                    "quit" => {
                        sup_menu.quitting.store(true, Ordering::SeqCst);
                        sup_menu.stop_child();
                        app_handle.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            let _ = win.unminimize();
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }
            let _tray = tray_builder.build(app)?;

            spawn_and_connect(
                app.handle().clone(),
                Arc::clone(&supervisor_setup),
                initial_project.clone(),
            );
            Ok(())
        })
        .on_window_event(move |window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    if !supervisor_window.quitting.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Failed to initialize Meta_Kim native desktop runtime");

    app.run(move |_app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            supervisor_exit.quitting.store(true, Ordering::SeqCst);
            supervisor_exit.stop_child();
        }
    });
}
