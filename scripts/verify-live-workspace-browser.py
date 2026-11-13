#!/usr/bin/env python3
"""Exercise the default Hub using real HTTP, UI controls, CLI and fixture files.

This validates product integration and layout, not AI output quality or native
runtime execution. It never reads a user home or invents a completed host run.
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
from urllib.parse import urlencode

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests/fixtures/live-workspace-browser-fixture.mjs"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "browser-artifacts/workspace")
    options = parser.parse_args()
    output = options.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    evidence = {"schemaVersion": 1, "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                "capturedAt": datetime.now(timezone.utc).isoformat(), "recordOrigin": "acceptance_fixture",
                "transport": "actual default Hub HTTP + browser UI + production host CLI",
                "modelCalled": False, "nativeInvocationVerified": False, "completionVerified": False,
                "checks": [], "screenshots": []}
    with tempfile.TemporaryDirectory(prefix="meta-kim-workspace-browser-") as temporary:
        project = Path(temporary) / "product-workspace"
        registry = Path(temporary) / "registry"
        environment = os.environ.copy()
        for key in ("CODEX_THREAD_ID", "META_KIM_LIVE_NATIVE_CODEX_BINDING", "META_KIM_LIVE_NATIVE_ZCODE_BINDING"):
            environment.pop(key, None)
        base_command = ["node", str(FIXTURE), "--project-root", str(project), "--registry-root", str(registry)]

        def action(name):
            result = subprocess.run([*base_command, "--action", name], cwd=ROOT, env=environment, text=True, capture_output=True, timeout=45, check=False)
            if result.returncode:
                raise RuntimeError(result.stderr or result.stdout)
            return json.loads(result.stdout)

        fixture = action("init")
        evidence["fixture"] = {key: fixture[key] for key in ("recordOrigin", "outlineSha256", "outlineBytes")}
        with (output / "workspace-server.log").open("w", encoding="utf-8") as error_log:
            server = subprocess.Popen([*base_command, "--action", "serve"], cwd=ROOT, env=environment,
                                      stdout=subprocess.PIPE, stderr=error_log, text=True)
            try:
                assert server.stdout is not None
                address = json.loads(server.stdout.readline())
                location = address["url"] + "/?" + urlencode({"projectId": fixture["projectId"], "runId": fixture["runId"]})
                with sync_playwright() as playwright:
                    launch_options = {"headless": True}
                    if os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE"):
                        launch_options["executable_path"] = os.environ["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
                    browser = playwright.chromium.launch(**launch_options)
                    evidence["browserVersion"] = browser.version
                    context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="zh-CN", reduced_motion="reduce", device_scale_factor=1)
                    page = context.new_page()
                    page.set_default_timeout(20_000)
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))

                    def capture(name, view):
                        page.evaluate("document.fonts.ready")
                        page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                        layout = page.evaluate("""() => ({
                          viewport: {width: innerWidth, height: innerHeight},
                          documentWidth: document.documentElement.scrollWidth,
                          workspaceWidth: document.querySelector('[data-live-workspace-root]').getBoundingClientRect().width,
                          stageCount: document.querySelectorAll('[data-live-workspace-stage]').length,
                          materialFontPx: document.querySelector('[data-live-workspace-material]') ? parseFloat(getComputedStyle(document.querySelector('[data-live-workspace-material]')).fontSize) : null
                        })""")
                        assert layout["documentWidth"] <= layout["viewport"]["width"] + 2, f"Page overflows horizontally: {layout}"
                        assert layout["stageCount"] == 8
                        assert layout["materialFontPx"] is None or layout["materialFontPx"] >= 13
                        page.mouse.move(1, 1)
                        file = output / name
                        page.screenshot(path=str(file), full_page=False, animations="disabled")
                        evidence["screenshots"].append({"file": name, "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "view": view, "layout": layout})
                        (output / (file.stem + ".txt")).write_text(page.locator("body").inner_text(), encoding="utf-8")

                    page.goto(location, wait_until="networkidle")
                    if page.locator("[data-live-language-select]").input_value() != "zh":
                        with page.expect_navigation(wait_until="networkidle"):
                            page.locator("[data-live-language-select]").select_option("zh")
                    expect(page.locator("[data-live-workspace-module]")).to_have_count(4)
                    expect(page.locator("[data-uw-origin]")).to_contain_text("验收")
                    capture("live-workspace-desktop.png", "Work / eight stages")
                    stage = page.locator('[data-live-workspace-stage="thinking"]')
                    stage.click()
                    expect(page.locator("[data-live-workspace-detail-close]")).to_be_focused()
                    capture("live-workspace-stage.png", "Actual stage details")
                    page.keyboard.press("Escape")
                    expect(stage).to_be_focused()
                    evidence["checks"].append("Eight actual stages; stage detail keyboard close returns focus")

                    page.locator('[data-live-workspace-nav="prd"]').click()
                    material = page.locator("[data-live-workspace-material]")
                    expect(material).to_contain_text("系统模块大纲")
                    capture("live-workspace-prd.png", "System outline / version-bound review")
                    pages = 1
                    while page.locator("[data-live-workspace-material-more]").count():
                        more = page.locator("[data-live-workspace-material-more]")
                        with page.expect_response(lambda response: "/api/workspace/material?" in response.url):
                            more.click()
                        page.wait_for_function("() => !document.querySelector('[data-live-workspace-material-more]') || !document.querySelector('[data-live-workspace-material-more]').disabled")
                        pages += 1
                        assert pages <= 12
                    expect(material).to_contain_text("FINAL_MATERIAL_PAGE_REACHED")
                    assert pages > 1
                    evidence["checks"].append(f"Long Unicode PRD loaded through {pages} real bounded pages")
                    with page.expect_response(lambda response: "/api/workspace/reviews?" in response.url and response.request.method == "POST") as approval_response:
                        page.locator('[data-live-workspace-review-choice="accept"]').click()
                    assert approval_response.value.status == 200
                    approval = approval_response.value.json()
                    assert approval["completionVerified"] is False
                    assert action("inspect")["nextAction"]["moduleId"] == "alpha"
                    action("advance")
                    page.locator("[data-uw-refresh]").click()
                    page.locator('[data-live-workspace-module="alpha"]').click()
                    expect(material).to_contain_text("资料收集：详细设计")
                    expect(page.locator('[data-live-workspace-review-choice="accept"]')).to_be_enabled()
                    capture("live-workspace-module.png", "Module detail after real host file report")
                    draft = "请保留原始材料，增加失败时的可见提示。\n第二行修改意见也要完整保留。"
                    feedback = page.locator("[data-live-workspace-feedback]")
                    feedback.fill(draft)
                    with page.expect_response(lambda response: "/api/workspace?" in response.url):
                        page.locator("[data-uw-refresh]").click()
                    expect(feedback).to_have_value(draft)
                    with page.expect_response(lambda response: "/api/workspace/reviews?" in response.url and response.request.method == "POST") as module_response:
                        page.locator('[data-live-workspace-review-choice="accept"]').click()
                    assert module_response.value.status == 200
                    current = action("inspect")
                    assert current["nextAction"]["moduleId"] == "beta"
                    expect(page.locator("[data-live-workspace-root]")).to_have_attribute("data-workspace-revision", str(current["revision"]))
                    evidence["checks"].append("UI outline approval → host CLI claim → actual file report → module approval → next module")
                    with page.expect_response(lambda response: "/api/workspace/feedback?" in response.url and response.request.method == "POST") as feedback_response:
                        page.locator("[data-live-workspace-submit-feedback]").click()
                    assert feedback_response.value.status == 200
                    assert feedback_response.value.json()["completionVerified"] is False
                    assert action("inspect")["nextAction"]["kind"] == "apply_feedback"
                    page.reload(wait_until="networkidle")
                    expect(page.locator('[data-live-workspace-module="alpha"]')).to_be_visible()
                    page.locator('[data-live-workspace-nav="records"]').click()
                    expect(page.locator("[data-live-workspace-event]").first).to_be_visible()
                    capture("live-workspace-records.png", "Durable review and feedback receipts")
                    evidence["checks"].append("Refresh retains draft; submitted feedback remains recorded after reload and never claims execution completion")

                    page.set_viewport_size({"width": 1024, "height": 900})
                    page.locator('[data-live-workspace-nav="prd"]').click()
                    page.locator('[data-live-workspace-prd-view="overview"]').click()
                    expect(page.locator("[data-live-workspace-material]")).to_contain_text("系统模块大纲")
                    capture("live-workspace-tablet.png", "Tablet outline")
                    page.set_viewport_size({"width": 390, "height": 844})
                    page.locator("[data-uw-nav-open]").click()
                    expect(page.locator("[data-uw-nav-open]")).to_have_attribute("aria-expanded", "true")
                    page.locator('[data-live-workspace-module="alpha"]').click()
                    expect(page.locator("[data-uw-nav-open]")).to_have_attribute("aria-expanded", "false")
                    expect(page.locator("[data-live-workspace-material]")).to_contain_text("资料收集：详细设计")
                    capture("live-workspace-mobile.png", "Mobile module with native navigation controls")
                    evidence["checks"].append("1440 / 1024 / 390 layouts have no document horizontal overflow; mobile navigation and readable PRD verified")
                    if errors:
                        raise RuntimeError("Browser error: " + errors[0])
                    evidence["checks"].append("No browser page errors")
                    context.close()
                    browser.close()
                    evidence["result"] = "passed"
            except Exception as error:
                evidence["result"] = "failed"
                evidence["error"] = str(error)
                raise
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)
                (output / "workspace-browser-evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"result": evidence["result"], "checks": len(evidence["checks"]), "screenshots": len(evidence["screenshots"])}))


if __name__ == "__main__":
    main()
