#!/usr/bin/env python3
"""Capture the real Live UI's built-in state demo, without a model or user home.

Requires Python Playwright plus Chromium. The script uses the shipped local
server and normal UI controls only. It does not replace DOM text, inject CSS,
seed invented host execution, or read a user's runtime/session configuration.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
VIEWPORT = {"width": 1600, "height": 1100}
LANGUAGES = [
    ("en", "en", "", "State demo", "Demo completion evidence"),
    ("zh", "zh-CN", ".zh-CN", "状态演示", "演示完成态证据"),
    ("ja", "ja-JP", ".ja-JP", "状態デモ", "デモの完了状態を示す証拠"),
    ("ko", "ko-KR", ".ko-KR", "상태 데모", "데모 완료 근거"),
]


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def digest(file: Path) -> str:
    return hashlib.sha256(file.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "browser-artifacts" / "readme")
    options = parser.parse_args()
    output = options.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    source_files = [
        "src/presentation/live/live-control-room-page.mjs",
        "src/presentation/live/live-ui-copy.mjs",
        "src/presentation/live/live-ui-copy.ja.mjs",
        "src/presentation/live/live-ui-copy.ko.mjs",
        "src/infrastructure/live/live-control-room-server.mjs",
        "scripts/capture-live-readme-screenshots.py",
    ]
    provenance = {
        "schemaVersion": 1,
        "sourceCommit": git("rev-parse", "HEAD"),
        "sourceTreeClean": not bool(git("status", "--porcelain", "--untracked-files=no")),
        "sourceFileSha256": {file: digest(ROOT / file) for file in source_files},
        "captureKind": "actual browser screenshot",
        "dataKind": "product built-in state demo; synthetic task data",
        "modelExecution": False,
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "screenshots": [],
    }
    with tempfile.TemporaryDirectory(prefix="meta-kim-readme-live-") as temporary:
        project = Path(temporary) / "project"
        (project / ".git").mkdir(parents=True)
        environment = os.environ.copy()
        # Explicit project-only API startup never reads the singleton registry.
        # Remove inherited bindings so this capture cannot observe a user turn.
        for key in ("CODEX_THREAD_ID", "META_KIM_LIVE_NATIVE_CODEX_BINDING", "META_KIM_LIVE_NATIVE_ZCODE_BINDING"):
            environment.pop(key, None)
        environment["META_KIM_README_PROJECT"] = str(project)
        server_source = """
import { startLiveControlRoom } from './scripts/meta-kim-live.mjs';
const live = await startLiveControlRoom({ projectRoot: process.env.META_KIM_README_PROJECT, port: 0 });
console.log(JSON.stringify({ url: live.url, readOnly: live.readOnly, controlEnabled: live.controlEnabled }));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await live.close(); process.exit(0); });
"""
        server_log = output / "capture-server.log"
        with server_log.open("w", encoding="utf-8") as error_log:
            server = subprocess.Popen(
                ["node", "--input-type=module", "-e", server_source], cwd=ROOT,
                env=environment, stdout=subprocess.PIPE, stderr=error_log, text=True,
            )
            try:
                assert server.stdout is not None
                address_line = server.stdout.readline()
                if not address_line:
                    raise RuntimeError(f"Live did not start; see {server_log.name}")
                address = json.loads(address_line)
                if address.get("readOnly") is not True or address.get("controlEnabled") is not False:
                    raise RuntimeError("README capture requires the real server's read-only mode")
                provenance["server"] = {"entrypoint": "startLiveControlRoom", "readOnly": True, "controlEnabled": False}
                with sync_playwright() as playwright:
                    launch_options = {"headless": True}
                    executable = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE")
                    if executable:
                        launch_options["executable_path"] = executable
                    browser = playwright.chromium.launch(**launch_options)
                    provenance["browserVersion"] = browser.version
                    try:
                        for language, html_language, suffix, title, evidence in LANGUAGES:
                            context = browser.new_context(viewport=VIEWPORT, locale="en-US", reduced_motion="reduce", device_scale_factor=1)
                            page = context.new_page()
                            page_errors: list[str] = []
                            page.on("pageerror", lambda error: page_errors.append(str(error)))
                            page.goto(address["url"] + "/?demo=states", wait_until="networkidle")
                            if page.locator('[data-live-language-select]').input_value() != language:
                                with page.expect_navigation(wait_until="networkidle"):
                                    page.locator('[data-live-language-select]').select_option(language)
                            page.wait_for_function("language => document.documentElement.lang === language", arg=html_language)
                            page.locator('.node-card[data-node-id="demo-requirements"] .node-identity-button').wait_for()
                            if title:
                                assert title in page.locator('[data-live-context-title]').inner_text()
                            stages = page.locator("details.stage-overview")
                            if not stages.evaluate("element => element.open"):
                                stages.locator("summary").click()
                            page.locator('[data-live-graph-fit]').click()
                            page.locator('[data-live-language-select]').blur()
                            page.mouse.move(1590, 1090)
                            page.evaluate("document.fonts.ready")
                            steps = ["Open /?demo=states", f"Choose {language} using the language selector", "Expand the eight-stage flow", "Fit the graph to the viewport"]
                            for view in ("task", "detail"):
                                if view == "detail":
                                    page.locator('.node-card[data-node-id="demo-requirements"] .node-identity-button').click()
                                    page.locator('[data-live-inspector-tab="evidence"]').click()
                                    page.locator('[data-live-inspector-panel="evidence"]').wait_for(state="visible")
                                    if evidence:
                                        assert evidence in page.locator('[data-live-inspector-panel="evidence"]').inner_text()
                                    steps += ["Click the Requirements analysis demo node", "Open the Evidence tab"]
                                    page.mouse.move(1590, 1090)
                                if page_errors:
                                    raise RuntimeError("Live page error: " + page_errors[0])
                                file = output / f"meta-kim-live-{view}{suffix}.png"
                                page.screenshot(path=str(file), full_page=False, animations="disabled")
                                provenance["screenshots"].append({
                                    "file": file.name, "language": language, "htmlLanguage": html_language,
                                    "urlPath": "/?demo=states", "viewport": VIEWPORT, "view": view,
                                    "actions": list(steps), "sha256": digest(file),
                                    "description": "Built-in demonstration of task states" if view == "task" else "The selected demo task's recorded demonstration evidence",
                                })
                                (output / f"visible-text-{language}-{view}.txt").write_text(page.locator("body").inner_text(), encoding="utf-8")
                            context.close()
                    finally:
                        browser.close()
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)
    provenance["status"] = "captured"
    (output / "meta-kim-live-screenshots.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "captured", "count": len(provenance["screenshots"]), "sourceCommit": provenance["sourceCommit"]}))


if __name__ == "__main__":
    main()
