#!/usr/bin/env python3
"""Browser acceptance for Meta_Kim's one-composer Agent + adjacent Live.

The HTTP server and Chromium are real. The research provider, draft content,
and business data are deterministic acceptance fixtures, not native execution.
This script must not certify a real CLI run, real web research, or delivery.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests/fixtures/agent-b-workflow-browser-fixture.mjs"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "browser-artifacts/agent-chat-live")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    evidence = {
        "schemaVersion": 1,
        "recordOrigin": "acceptance_fixture",
        "browserTransport": "actual Chromium + localhost HTTP",
        "modelCalled": False,
        "nativeInvocationVerified": False,
        "executionAuthorized": False,
        "completionVerified": False,
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "sourceFingerprints": {
            "agentDesktopSha256": hashlib.sha256(
                (ROOT / "src/presentation/live/live-agent-desktop.mjs").read_bytes()).hexdigest(),
            "workspaceStylesSha256": hashlib.sha256(
                (ROOT / "src/presentation/live/live-workspace-styles.mjs").read_bytes()).hexdigest(),
        },
        "checks": [],
        "screenshots": [],
        "result": "pending",
    }
    environment = os.environ.copy()
    # Explicitly avoid drawing on the account holder's model credentials.
    for name in ("CODEX_TOKEN", "OPENAI_API_KEY", "CODEX_THREAD_ID", "ANTHROPIC_API_KEY"):
        environment.pop(name, None)

    with tempfile.TemporaryDirectory(prefix="meta-kim-chat-live-browser-") as temporary:
        project_root = Path(temporary) / "synthetic-ecommerce-project"
        project_root.mkdir()
        (project_root / ".git").mkdir()
        server = subprocess.Popen(
            ["node", str(FIXTURE), "--project-root", str(project_root)],
            cwd=ROOT,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            assert server.stdout is not None
            line = server.stdout.readline().strip()
            if not line:
                raise RuntimeError("Fixture server did not produce a localhost address")
            launch = json.loads(line)
            if launch.get("recordOrigin") != "acceptance_fixture":
                raise AssertionError("Fixture lost the required simulation provenance")

            with sync_playwright() as playwright:
                launch_options = {"headless": True}
                if environment.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE"):
                    launch_options["executable_path"] = environment["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
                browser = playwright.chromium.launch(**launch_options)
                evidence["browserVersion"] = browser.version
                context = browser.new_context(
                    viewport={"width": 1600, "height": 960},
                    locale="zh-CN",
                    reduced_motion="reduce",
                )
                page = context.new_page()
                page.set_default_timeout(20_000)
                errors: list[str] = []
                writes: list[str] = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.on("request", lambda request: writes.append(
                    f"{request.method} {request.url.split('?')[0]}") if request.method != "GET" else None)

                def capture(filename: str, step: str) -> None:
                    page.evaluate("document.fonts.ready")
                    page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                    geometry = page.evaluate("""() => ({
                      width: innerWidth,
                      documentWidth: document.documentElement.scrollWidth,
                      visibleComposers: [...document.querySelectorAll('textarea')]
                        .filter(el => {
                          const style = getComputedStyle(el);
                          const rect = el.getBoundingClientRect();
                          return style.display !== 'none' && style.visibility !== 'hidden'
                            && rect.width > 0 && rect.height > 0;
                        }).length,
                      chatWidth: document.querySelector('[data-uw-agent-chat]')?.getBoundingClientRect().width,
                      liveWidth: document.querySelector('[data-uw-agent-live]')?.getBoundingClientRect().width,
                    })""")
                    assert geometry["documentWidth"] <= geometry["width"] + 2, (
                        f"Viewport overflow at {step}: {geometry}")
                    assert geometry["visibleComposers"] == 1, (
                        f"Exactly one visible text input required at {step}: {geometry}")
                    path = output / filename
                    page.mouse.move(1, 1)
                    page.screenshot(path=str(path), full_page=False, animations="disabled")
                    evidence["screenshots"].append({
                        "file": filename,
                        "step": step,
                        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                        "geometry": geometry,
                    })

                page.goto(launch["url"], wait_until="domcontentloaded")
                language = page.locator("[data-live-language-select]")
                if language.count() and language.input_value() != "zh":
                    with page.expect_navigation(wait_until="domcontentloaded"):
                        language.select_option("zh")

                composer = page.locator("[data-uw-chat-input]")
                live = page.locator("[data-uw-agent-live]")
                expect(composer).to_be_visible()
                expect(live).to_be_visible()
                expect(page.locator('[data-uw-live-mode="flow"]')).to_have_attribute("aria-selected", "true")
                expect(page.locator(".uw-cockpit-pillar")).to_have_count(5)
                capture("01-chat-and-live-initial.png", "Single input with adjacent live process and 5-pillar cockpit")
                evidence["checks"].append("Single visible composer, real adjacent Live, no horizontal overflow")

                # Native client cards use real DOM from the current source, but
                # fixture host data remains simulated. This checks the UI contract
                # only; it is not evidence of installed local clients or CLI runs.
                inventory = page.locator("[data-uw-agent-inventory]")
                native_shortcut = inventory.locator('[data-target-section="native-hosts"]')
                expect(native_shortcut).to_be_visible(timeout=20_000)
                native_shortcut.click()
                native_section = inventory.locator('details[data-section="native-hosts"]')
                expect(native_section).to_have_js_property("open", True)
                expect(native_section.locator(".uw-native-host")).to_have_count(2, timeout=20_000)
                native_hosts = native_section.locator(".uw-native-host")
                expect(native_hosts.first).to_contain_text("Claude Code")
                expect(native_hosts.nth(1)).to_contain_text("Codex")
                native_hosts.first.locator("summary").click()
                expect(native_hosts.first.locator(".uw-native-host-access")).to_contain_text("接入方式")
                expect(native_section).to_contain_text("当前服务端宿主")
                capture("01b-service-host-inventory-fixture.png",
                        "Current-source native host cards from simulated fixture data; not real client installation")
                evidence["checks"].append(
                    "Native host categories are visible in the sidebar; simulated config is not an invocation")

                goal = ("给跨境电商团队做一个可复核的经营与知识分析工具。"
                        "请比较三种方案，设计分阶段的系统与模块，保留逐节点修改和人工批准。")
                composer.fill(goal)
                composer.press("Enter")
                expect(page.locator(".uw-chat-options")).to_be_visible(timeout=25_000)
                expect(page.locator(".uw-chat-option")).to_have_count(3)
                capture("02-research-options.png", "Three fixture-generated options within the conversation")
                evidence["checks"].append("B1 options appear in chat without a separate editable form")

                page.locator(".uw-chat-option").nth(1).click()
                composer.fill("先验证数据质量和检索效果，再做经营决策；模块可以独立返工。")
                composer.press("Enter")
                expect(page.locator(".uw-chat-design-card")).to_be_visible(timeout=25_000)
                expect(page.locator("[data-uw-chat-thread]")).to_contain_text("采纳", timeout=25_000)
                capture("03-human-b1-decision.png", "B1 choice recorded with a human rationale")
                evidence["checks"].append("Human B1 decision passed through the original versioned HTTP endpoint")

                page.locator('[data-uw-live-mode="knowledge"]').click()
                expect(page.locator('[data-uw-live-mode="knowledge"]')).to_have_attribute("aria-selected", "true")
                expect(page.locator(".uw-agent-knowledge .uw-kg-node")).to_have_count(3, timeout=25_000)
                capture("04-dynamic-knowledge-graph.png", "Current two-level PRD graph with module dependency")
                evidence["checks"].append("Actual graph renders system and two module nodes from a bound draft")

                card = page.locator(".uw-chat-design-card")
                save = card.get_by_role("button", name="保存设计草稿，进入人工审阅")
                expect(save).to_be_visible(timeout=25_000)
                save.click()
                expect(card.locator(".uw-chat-review-details summary")).to_be_visible(timeout=25_000)
                capture("05-b2-saved.png", "Versioned PRD saved for human approval")
                evidence["checks"].append("B2 saved through versioned design endpoint")

                module = page.locator('.uw-agent-knowledge .uw-kg-node[data-kind="module"]').first
                expect(module).to_be_visible()
                module.click()
                expect(page.locator("[data-uw-chat-target]")).to_be_visible()
                linked_title = page.locator("[data-uw-chat-target-text]").inner_text()
                assert linked_title.strip(), "Selected node did not reach the composer"
                capture("06-node-selected.png", "Graph node selection scopes the same chat composer")
                composer.fill("这个节点的验收指标要具体可测，还要明确数据隔离边界。")
                composer.press("Enter")
                expect(page.locator("[data-uw-chat-target]")).to_be_hidden()
                expect(page.locator("[data-uw-chat-thread]")).to_contain_text("数据隔离边界")
                expect(page.locator("[data-uw-chat-thread]")).to_contain_text(
                    "已记录的节点修改意见", timeout=25_000)
                evidence["checks"].append("Graph node feedback persisted through B2 design endpoint")

                module = page.locator('.uw-agent-knowledge .uw-kg-node[data-kind="module"]').first
                expect(module).to_be_visible()
                module.click()
                composer.fill("验收改为：订单去重可对账；项目间的数据隔离通过回归测试。")
                composer.press("Enter")
                expect(page.locator("[data-uw-chat-target]")).to_be_hidden()
                capture("07-b2-revised.png", "Scoped node feedback resolved with a versioned PRD edit")
                evidence["checks"].append("A direct PRD field revision resolved the recorded note")

                page.locator('[data-uw-live-mode="flow"]').click()
                expect(page.locator(".uw-agent-flow-node")).to_have_count(6)
                capture("08-flow-after-feedback.png", "Live process and status after a focused node edit")

                for expected_name in ("跨境电商经营知识工作台（模拟草稿）", "数据接入与质量检查", "检索与经营分析"):
                    summary = card.locator(".uw-chat-review-details summary")
                    expect(summary).to_contain_text(expected_name, timeout=25_000)
                    summary.click()
                    if expected_name == "数据接入与质量检查":
                        expect(card.locator(".uw-chat-review-fields")).to_contain_text(
                            "项目间的数据隔离通过回归测试", timeout=25_000)
                    approval = card.get_by_role("button", name=f"确认「{expected_name}」")
                    expect(approval).to_be_enabled(timeout=25_000)
                    approval.click()
                expect(card).to_contain_text("设计已逐项确认", timeout=25_000)
                capture("09-b2-reviewed.png", "B2 full-system and dependency-ordered module review")
                evidence["checks"].append("Complete PRD expanded and three backend approvals recorded")

                # Static B3 handoff does not prove a real governed Run, but it
                # must be accessible from the conversation if the UI promises
                # an end-to-end path with only one visible input.
                prepare = card.get_by_role("button", name="准备交接", exact=False)
                expect(prepare).to_be_visible(timeout=15_000)
                prepare.click()
                expect(card).to_contain_text("交接", timeout=20_000)
                capture("10-static-handoff.png", "B3 immutable handoff, no simulated execution success")
                evidence["checks"].append("Static handoff recorded; host execution and B4 remain unverified")

                page.locator('[data-uw-live-mode="agents"]').click()
                expect(page.locator('[data-uw-live-mode="agents"]')).to_have_attribute("aria-selected", "true")
                capture("11-agent-relations.png", "Real agent telemetry or explicitly unproven empty state")

                page.set_viewport_size({"width": 390, "height": 844})
                expect(composer).to_be_visible()
                capture("12-mobile-chat-live.png", "Phone viewport with exactly one input and accessible Live")
                evidence["checks"].append("Mobile layout keeps chat input available without page overflow")

                assert not errors, "Browser JavaScript errors: " + "; ".join(errors)
                evidence["checks"].append("No uncaught JavaScript errors")
                assert any("/api/agent/start" in item for item in writes), writes
                assert any("/api/agent/decisions" in item for item in writes), writes
                assert any("/api/agent/designs" in item for item in writes), writes
                assert any("/api/agent/handoff" in item for item in writes), writes
                evidence["checks"].append("Real HTTP writes reached research, decision, design and handoff")

                context.close()
                browser.close()
                evidence["result"] = "passed_fixture_chat_live_b1_b2_b3"
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
            (output / "agent-chat-live-evidence.json").write_text(
                json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"result": evidence["result"], "checks": len(evidence["checks"]),
                      "screenshots": len(evidence["screenshots"])}))


if __name__ == "__main__":
    main()
