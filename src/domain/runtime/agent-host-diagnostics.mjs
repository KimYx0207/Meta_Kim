/**
 * Human-facing diagnostics for the explicit local Agent host allowlist.
 * Detection, launch approval and authentication are independent facts. This
 * pure mapping never probes a client, reads credentials or grants execution.
 */

function parseCliVersion(version) {
  const match = String(version ?? "").match(/(?:^|[^\d])v?(\d+)\.(\d+)\.(\d+)(?!\d)/u);
  return match ? match.slice(1).map(Number) : null;
}

export function meetsAgentHostMinimumVersion(version, minimum) {
  const actual = parseCliVersion(version);
  const expected = parseCliVersion(minimum);
  if (!actual || !expected) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > expected[index]) return true;
    if (actual[index] < expected[index]) return false;
  }
  return true;
}

function statusGuidance(host, reason) {
  const label = host.label;
  switch (reason) {
    case "client_not_installed":
      return {
        statusLabel: "未检测到客户端",
        nextAction: host.profile
          ? `请先安装 ${label}，确认终端能运行 ${host.command}，然后点击「重新检测客户端」。`
          : `${label} 尚未安装。安装后可以检测状态，但当前版本仍未开放自动启动；可先选用已支持的客户端。`,
      };
    case "client_detection_not_verified":
      return {
        statusLabel: "客户端状态待确认",
        nextAction: `请检查 ${label} 的安装和终端 PATH 设置，确认版本命令能运行后重新检测。${host.profile ? "" : "此客户端目前仍未开放自动启动。"}`,
      };
    case "client_version_unreviewed":
      return {
        statusLabel: "客户端版本需更新",
        nextAction: `请将 ${label} 更新到 ${host.profile.minimumVersion} 或更新版本，再点击「重新检测客户端」。`,
      };
    case "personal_codex_token_not_authorized":
      return {
        statusLabel: "已检测，暂不开放启动",
        nextAction: "当前入口不会读取或使用个人 Codex Token。请选用已开放安全启动的客户端。",
      };
    case "read_only_plan_verified":
      return {
        statusLabel: "可用于只读研究",
        nextAction: "可以输入任务开始研究并查看建议；实际修改、执行和交付仍需要后续确认与验收。",
      };
    default:
      return {
        statusLabel: "已检测，暂不支持启动",
        nextAction: `${label} 已检测到，但尚未完成安全启动协议的审阅。当前只能查看状态，请选用已支持的客户端。`,
      };
  }
}

export function diagnoseAgentHost(host, probeResult) {
  const available = probeResult?.status === "detected";
  // A future profile edit must not silently authorize the personal Codex
  // credential route; this policy is independent of version compatibility.
  const launchSupported = host.id !== "codex" && available && !!host.profile
    && meetsAgentHostMinimumVersion(probeResult.version, host.profile.minimumVersion);
  const reason = !available
    ? (probeResult?.status === "not_found" ? "client_not_installed" : "client_detection_not_verified")
    : host.id === "codex"
      ? "personal_codex_token_not_authorized"
      : !host.profile
        ? host.unavailableReason
        : launchSupported ? "read_only_plan_verified" : "client_version_unreviewed";
  return { available, launchSupported, reason, ...statusGuidance(host, reason) };
}
