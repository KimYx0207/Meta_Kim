# Meta_Kim Agent 工作台 / Agent workspace

这个入口属于 **Meta_Kim**，不是新的产品或另一套 Agent 调度器。它复用原 Live 工作台；Kim_Service 仍是可选的专业能力来源。没有复制 KimStudio 或 CC Switch 的第三方代码。

## 打开 / Open

在已安装 Meta_Kim 的项目目录中运行：

```powershell
meta-kim agent
```

从源码运行：

```powershell
npm run meta:agent
```

也可以明确指定项目目录：

```powershell
meta-kim agent --project-root "D:\kimproject\your-project"
```

项目目录必须已经包含 `.git` 或 `.meta-kim` 标记。应用只绑定这个明确的本地目录，浏览器不能任意更换 Agent 执行位置。安装了 Chrome/Edge 等受支持浏览器时优先以独立应用窗口打开；否则会给出回环地址。`--no-open` 可以只启动服务。关闭启动它的终端会关闭本地入口和它持有的 Agent 请求。

## 普通用户看到什么 / What a first-time user sees

1. 在“说出你想做的事”输入结果目标。无需先理解 Skill、MCP 或 PRD。
2. 软件检测本机客户端，并区分“检测到”“具备已审阅安全启动协议”“当前不允许执行”。
3. 用户主动选择可启动客户端并提交。重复点击、网络超时和回执对账使用同一请求号，防止同一个任务意外执行两次。
4. 启动后自动刷新真实回执；完成时可展开只读研究建议。通过原本的 Live 页面查看已有阶段、关键选择、交付物和验收；其中每种状态都有独立的来源与证明边界。

## 当前边界 / Current limitations

- **现阶段开放 Claude Code（2.1.259 及以上）与 Gemini CLI（0.68.0 及以上）的只读 plan 模式。** 启动参数使用固定白名单，用户任务通过 stdin 提供，不执行项目写入。CLI 被检测到，不代表已通过启动版本与安全策略审阅。
- Codex、ZCode、DSH、OpenCode、OpenClaw 显示检测状态，但尚未完成当前项目安全启动协议的验证，不开放启动。特别是不会自动使用用户个人 Codex Token。
- 如项目中安装了可验证的 Kim_Service，Meta 通过已有的来源哈希与方法契约选择专业能力，传递给只读研究阶段；没有验证通过时不冒充专业调用成功。
- 一次原生 CLI **接单**并不意味着 Meta 已建立一个治理 `runId`；研究阶段结束也不代表完整目标已经实现、验收通过。只有既有原生事件与 Meta 记录提供确切绑定，Live 才展示对应任务图与“完成”证据。
- 请求回执保存在当前入口进程中。重启入口后需从已有的真实治理记录继续；不能把内存回执当作可跨会话恢复的任务数据库。
- 这是 Meta 的本地应用入口，不是已签名的 Windows/macOS 安装包。

保持原命令 `meta-kim live` 的全局 Hub 只读。Agent 启动路由仅在明确运行 `meta-kim agent` 时注册，限定 `127.0.0.1`、一次性会话令牌、Same-Origin 与固定项目目录。用户输入不被拼接成 Shell 命令，也不会展示原始 CLI 错误输出或用户认证信息。

---

**English summary:** Run `meta-kim agent` from a marker-backed project folder. This is an opt-in, loopback-only application view of the existing Meta Live workspace, not a new repository or scheduler. Reviewed native launch profiles include Claude Code and Gemini CLI in read-only plan mode, with optional hash-verified Kim_Service method handoff. Other hosts are detected but are not authorized to launch until separately reviewed. A native intake receipt, a Meta run, and a verified deliverable are different things. `meta-kim live` retains its existing read-only behavior.
