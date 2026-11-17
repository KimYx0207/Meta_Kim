#!/usr/bin/env python3
"""B-path UI screenshots against localhost with an explicit fake research host.

This checks actual Chromium DOM and HTTP integration, not native CLI execution.
It must never be cited as proof of an actual governed Run or completed product.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests/fixtures/agent-b-workflow-browser-fixture.mjs"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "browser-artifacts/agent-b")
    options = parser.parse_args()
    output = options.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    evidence = {"recordOrigin": "acceptance_fixture", "modelCalled": False,
                "nativeInvocationVerified": False, "completionVerified": False,
                "capturedAt": datetime.now(timezone.utc).isoformat(),
                "screenshots": [], "checks": [], "result": "pending"}
    with tempfile.TemporaryDirectory(prefix="meta-kim-b-browser-") as temporary:
        project = Path(temporary) / "ecommerce-trial"
        project.mkdir()
        (project / ".git").mkdir()
        environment = os.environ.copy()
        for name in ("CODEX_TOKEN", "OPENAI_API_KEY", "CODEX_THREAD_ID"):
            environment.pop(name, None)
        server = subprocess.Popen(["node", str(FIXTURE), "--project-root", str(project)],
                                  cwd=ROOT, env=environment, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True)
        try:
            assert server.stdout is not None
            launch = json.loads(server.stdout.readline())
            assert launch["recordOrigin"] == "acceptance_fixture"
            with sync_playwright() as playwright:
                launch_options = {"headless": True}
                if environment.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE"):
                    launch_options["executable_path"] = environment["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
                browser = playwright.chromium.launch(**launch_options)
                evidence["browserVersion"] = browser.version
                context = browser.new_context(viewport={"width": 1440, "height": 1000},
                                              locale="zh-CN", reduced_motion="reduce")
                page = context.new_page()
                page.set_default_timeout(15_000)
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))

                def capture(filename, step):
                    page.evaluate("document.fonts.ready")
                    page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                    shape = page.evaluate("""() => ({width: innerWidth, height: innerHeight,
                      documentWidth: document.documentElement.scrollWidth,
                      title: document.querySelector('[data-uw-title]')?.innerText,
                      agentVisible: getComputedStyle(document.querySelector('[data-uw-agent-entry]')).display !== 'none'})""")
                    assert shape["documentWidth"] <= shape["width"] + 2, f"Horizontal overflow: {shape}"
                    file = output / filename
                    page.mouse.move(1, 1)
                    page.screenshot(path=str(file), animations="disabled", full_page=False)
                    evidence["screenshots"].append({"step": step, "file": filename,
                        "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "shape": shape})
                    (output / (file.stem + ".txt")).write_text(page.locator("body").inner_text(), encoding="utf-8")

                # Live can hold an open stream while the workspace remains
                # interactive. Waiting for networkidle can therefore time out
                # even after the document and controls are fully rendered.
                page.goto(launch["url"], wait_until="domcontentloaded")
                if page.locator("[data-live-language-select]").input_value() != "zh":
                    with page.expect_navigation(wait_until="domcontentloaded"):
                        page.locator("[data-live-language-select]").select_option("zh")
                expect(page.locator("[data-uw-agent-entry]")).to_be_visible()
                if page.locator("[data-uw-agent-host]").is_disabled():
                    capture("00-client-diagnostic.png", "Client discovery first response")
                    refresh = page.locator("[data-uw-agent-redetect]")
                    if refresh.is_visible():
                        refresh.click()
                expect(page.locator("[data-uw-agent-host]")).to_be_enabled()
                page.locator("[data-uw-agent-goal]").fill(
                    "给跨境电商团队做可复核的经营与知识分析工具，先对比三种方案。我需要保留人工批准、模块返工和最终验收。")
                capture("01-goal.png", "Bind project and enter a goal")

                page.locator("[data-uw-agent-submit]").click()
                page.locator("[data-uw-agent-verify]").click()
                expect(page.locator("[data-uw-agent-result]")).to_be_visible()
                expect(page.locator("[data-uw-agent-options]")).to_be_visible()
                expect(page.locator("[data-uw-agent-options] button")).to_have_count(3)
                capture("02-options.png", "Compare three unverified research options")
                evidence["checks"].append("Three model-unverified options are separately visible and clickable")

                page.locator("[data-uw-agent-options] button").nth(1).click()
                expect(page.locator("[data-uw-agent-strategy]")).to_have_value("B：按模块分阶段交付")
                page.locator("[data-uw-agent-choice-reason]").fill("先验证数据和检索，后续模块可以独立返工，能控制风险。")
                expect(page.locator("[data-uw-agent-adopt]")).to_be_enabled()
                page.locator("[data-uw-agent-adopt]").click()
                expect(page.locator("[data-uw-agent-decision-receipt]")).to_be_visible()
                expect(page.locator("[data-uw-agent-design]")).to_be_visible()
                capture("03-approved-b1.png", "Actual local decision, next B2 design draft")
                evidence["checks"].append("Human selection and rationale recorded without creating an execution Run")

                design = page.locator("[data-uw-agent-design-body]")
                expect(page.locator("[data-uw-agent-draft-status]")).to_contain_text("已载入原生只读草稿")
                capture("04-b2-generated.png", "Fake read-only provider produced an editable system and two-module PRD")
                evidence["checks"].append("A clearly fixture-labelled read-only draft prefilled both PRD layers")
                (output / "b2-form-html.txt").write_text(design.inner_html(), encoding="utf-8")
                (output / "b2-form-text.txt").write_text(design.inner_text(), encoding="utf-8")

                # The provider here is an explicit fixture, not a real model.
                # Edit its draft as a person, so approval covers the edited
                # version and does not silently accept the original answer.
                system_fields = design.locator(".uw-agent-design-form").nth(0)
                for panel in design.locator("details.uw-agent-design-panel").all():
                    if not panel.evaluate("node => node.open"):
                        panel.locator("summary").click()
                expect(system_fields.locator("input")).to_have_value("跨境电商经营知识工作台（模拟草稿）")
                system_fields.locator("input").fill("跨境电商经营知识工作台（人工修订）")
                module_fields = design.locator(".uw-agent-design-form").nth(1)
                expect(module_fields.locator("input")).to_have_value("数据接入与质量检查")
                module_fields.locator("textarea").first.fill("人工明确：只在已隔离的测试目录读合成数据，不连生产数据库。")
                page.get_by_role("button", name="保存设计并进入人工审阅").click()
                expect(page.locator("[data-uw-agent-design-status]")).to_contain_text("版本")
                design.scroll_into_view_if_needed()
                capture("05-b2-saved.png", "Versioned and human-edited two-level design pending approval")
                (output / "b2-after-save-html.txt").write_text(design.inner_html(), encoding="utf-8")
                (output / "b2-after-save-text.txt").write_text(design.inner_text(), encoding="utf-8")
                evidence["checks"].append("Two-module dependency PRD and human edits persisted without creating a Run")

                transfer = page.locator("[data-uw-agent-transfer]")
                expect(transfer).to_be_visible()
                expect(transfer.locator("[data-uw-agent-transfer-prepare]")).to_be_disabled()
                design.get_by_role("button", name="批准系统设计").click()
                for summary in design.locator("details.uw-agent-design-panel > summary").all():
                    if not summary.evaluate("node => node.parentElement.open"):
                        summary.click()
                expect(design.get_by_role("button", name="批准模块设计")).to_have_count(2)
                expect(design.get_by_role("button", name="批准模块设计").nth(1)).to_be_disabled()
                design.get_by_role("button", name="批准模块设计").first.click()
                capture("06a-module1-action.png", "First module-approval response and any inline error")
                # Submit = v1, approve system = v2, approve first module = v3.
                expect(page.locator("[data-uw-agent-design-status]")).to_contain_text("版本 3")
                # The design component reconstructs its accessible tree after
                # each versioned approval; re-open the remaining module.
                for summary in design.locator("details.uw-agent-design-panel > summary").all():
                    if not summary.evaluate("node => node.parentElement.open"):
                        summary.click()
                expect(design.get_by_role("button", name="批准模块设计")).to_have_count(1)
                expect(design.get_by_role("button", name="批准模块设计")).to_be_enabled()
                design.get_by_role("button", name="批准模块设计").click()
                expect(transfer.locator("[data-uw-agent-transfer-prepare]")).to_be_enabled()
                transfer.scroll_into_view_if_needed()
                capture("06-b2-approved.png", "Human approved system and both dependency-ordered modules")
                evidence["checks"].append("System then dependency-ordered module approvals are enforced")

                transfer.locator("[data-uw-agent-transfer-prepare]").click()
                expect(transfer.locator("[data-uw-agent-transfer-receipt]")).to_be_visible()
                capture("07-handoff-prepared.png", "Immutable handoff packet, still no actual execution")
                evidence["checks"].append("The approved design produced a static handoff receipt only")

                # The browser is real, but this fixture has no validated host,
                # no governed Run and no user B4 acceptance of a deliverable.
                assert not errors, "JavaScript errors: " + "; ".join(errors)
                evidence["checks"].append("No browser JavaScript errors; no native run or completed artifact claimed")
                context.close()
                browser.close()
                evidence["result"] = "passed_b1_b2_static_handoff"
        except Exception as error:
            evidence["result"] = "failed"
            evidence["error"] = str(error)
            raise
        finally:
            server.terminate()
            try:
                server.communicate(timeout=7)
            except subprocess.TimeoutExpired:
                server.kill()
                server.communicate(timeout=5)
            (output / "agent-b-browser-evidence.json").write_text(json.dumps(evidence, indent=2,
                ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"result": evidence["result"], "checks": len(evidence["checks"]),
                      "screenshots": len(evidence["screenshots"])}))


if __name__ == "__main__":
    main()
