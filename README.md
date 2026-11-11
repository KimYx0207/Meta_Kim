<div align="center">

# 元 · Meta_Kim

**From one idea to coordinated, verifiable work.**

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

[![GitHub stars](https://img.shields.io/github/stars/KimYx0207/Meta_Kim?style=flat&label=stars)](https://github.com/KimYx0207/Meta_Kim/stargazers)
[![license Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)

</div>

## Turn an idea into a finished piece of work

**Meta_Kim helps your AI assistant plan, coordinate and finish work across files, specialties and sessions.** Describe the outcome in your usual client. Meta_Kim gathers project context, compares useful approaches, organizes the work and keeps the decisions available for the next session.

> “Build a mobile-friendly event registration tool. Help me choose an approach, keep the attendee list accurate, and show me that registration and export work.”

![From your goal through research, a two-level PRD and specialist work to a checked result](docs/images/intent-to-delivery.svg)

*How the two projects work together. Tasks with satisfied dependencies can proceed in parallel.*

| What you need | What Meta_Kim organizes |
| --- | --- |
| A clear direction | Project facts, useful references, options and a recommendation |
| A plan people can build | One PRD: system and technology choices, then modules, interfaces and acceptance |
| Professional execution | Specialists with the relevant methods, project materials and output criteria |
| Work that survives interruptions | Saved decisions, completed results, dependencies and the next action |
| Visible progress | The Live task board, current owners, outputs and checks |

**[Kim Service](https://github.com/KimYx0207/Kim_Service) supplies the professional methods; Meta_Kim coordinates the whole job.** Use them together or connect other capability sources. Product direction goes to you when a choice materially changes the outcome; routine implementation decisions stay with the working team.

## Start in three steps

Requires **Node.js 22.13.0+** and a configured AI client. Current release: **[v3.10.0](https://github.com/KimYx0207/Meta_Kim/releases/tag/v3.10.0)**.

**1. Install and choose your clients.**

```bash
git clone https://github.com/KimYx0207/Meta_Kim.git
cd Meta_Kim
npm install
node setup.mjs
```

The default install reuses capabilities globally. Choose project setup when a project needs its own configuration; add `--with-global-hooks` when you want global Hooks. Existing user settings are merged. You can also start with `npx --yes github:KimYx0207/Meta_Kim`.

**2. Open your project and describe the outcome.**

You do not need to memorize commands or choose technical roles. Explain what should work and what you want to preserve. The assistant reads available project information and asks questions that change the plan.

**3. Follow the work and try the result.**

Open the current run's Live link or run `node bin/meta-kim.mjs live`. The board connects tasks, owners, dependencies and outputs. [View the real Live renderer with Chinese demo data](docs/images/meta-kim-live-demo.png).

To update a clone:

```bash
git pull --ff-only
node setup.mjs --update
node setup.mjs --check
```

## Client integrations

| Client | Available integration |
| --- | --- |
| **Codex · Claude Code** | Main integrations: native instructions, Agents, Skills, configuration and Hooks |
| **Cursor · OpenClaw** | Optional compatibility integrations using each client's supported formats |
| **Gemini CLI** | Optional native Agents, shared Skills, settings and Hooks |
| **ZCode** | Optional Agents, Skills, MCP and user-level Hooks |
| **DSH — DeepSeek Harness** | Native Skills, an isolated profile or project setup, and MCP |
| **Qoder · Trae** | Beta compatibility adapters |

Installation, package loading and task execution have separate test coverage. DSH has an official no-model configuration/Skill/MCP probe; Gemini CLI and ZCode have projection and lifecycle checks. Native model task quality is evaluated on the actual task. See the [compatibility catalog](config/runtime-compatibility-catalog.json) and [verification record](docs/verification/dsh-professional-quality-20261111.md) for details. Dependency projects maintain their own client support.

### DSH quick start

DSH requires **Node.js 24.9.0+**. The integration is checked against DSH `0.2.2-rc.1`.

```sh
node bin/meta-kim.mjs dsh install
node bin/meta-kim.mjs dsh check
dsh --profile meta-kim
```

Add `--service-package /path/to/kim-service-dsh` to include the professional packages built by [Kim Service](https://github.com/KimYx0207/Kim_Service/blob/main/docs/dsh.md). The same entry supports `update` and `uninstall`. [DSH guide](canonical/skills/meta-theory/references/runtime-dsh.md) · [ZCode guide](canonical/skills/meta-theory/references/runtime-zcode.md).

## Keep work moving, contain repeated failures

The default Hook mode gives guidance as work proceeds. It no longer switches to blocking merely because a project has been running for seven days.

A prepared single-task work order can start a monitored trial. For supervised tasks, two ineffective attempts with the same strategy and evidence open a fuse for that task. Independent work continues. A reviewed change of approach gets a recovery trial, with its outcome recorded before wider reuse. Permissions, file ownership and destructive actions still follow the current authorization.

Waiting for your review also affects only the tasks that depend on it. Completed independent work stays available when you resume. Reusable improvements follow the same practical idea: try a candidate, measure the result, then promote a version that has earned its place.

<details>
<summary>Optional memory service</summary>

Project continuity uses durable run records. If you also enable Memory, check its configured endpoint, for example:

```bash
curl -fsS --max-time 3 http://127.0.0.1:8000/api/health
```

Memory configuration in `.mcp.json`, hook installation, service health, writes, reads and cross-session recall are checked separately. `npm run meta:test:mcp` checks Meta_Kim's own MCP server. Health checks alone report service availability.

</details>

## Explore and contribute

| Location | Purpose |
| --- | --- |
| `canonical/` | Shared Agents, Skills, rules and runtime assets |
| `config/` | Capability indexes and machine-readable contracts |
| `scripts/` · `src/` | Installation, execution, storage and Live |
| `tests/` | Behavior and regression checks |
| `.meta-kim/` | Local task state, planning and backups |

Client-specific directories are generated locally from shared sources and excluded from GitHub source by `.gitignore`. Read [AGENTS.md](AGENTS.md) before contributing.

[Architecture](docs/harness-architecture.md) · [Intent to delivery](canonical/skills/meta-theory/references/intent-to-delivery.md) · [Live SDK](docs/live-sdk.md) · [Changelog](CHANGELOG.md)

## Contact

![Contact QR](docs/images/contact-qr.png)

GitHub <a href="https://github.com/KimYx0207">KimYx0207</a> |
X <a href="https://x.com/KimYx0207">@KimYx0207</a> |
Website <a href="https://www.aiking.dev/">aiking.dev</a> |
WeChat Official Account: <strong>老金带你玩AI</strong>

Feishu knowledge base:
<a href="https://my.feishu.cn/wiki/OhQ8wqntFihcI1kWVDlcNdpznFf">long-term updates</a>

### Buy me a coffee

If Meta_Kim has been useful, support the project with a coffee.

<table align="center">
<tr><th>WeChat Pay</th><th>Alipay</th></tr>
<tr>
<td align="center"><img src="docs/images/wechat-pay.jpg" width="260" alt="WeChat Pay QR"></td>
<td align="center"><img src="docs/images/alipay.jpg" width="260" alt="Alipay QR"></td>
</tr>
</table>

### Method basis

Meta_Kim’s methodological foundation comes from research on meta-based intent amplification, authored by this project’s maintainer (KimYx0207):

- Paper: <https://zenodo.org/records/18957649>
- DOI: `10.5281/zenodo.18957649`

---

## License

[Apache License 2.0](LICENSE). Commercial use is allowed. When redistributing Meta_Kim or substantial portions, retain [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party capabilities keep their own licenses. Attribution must not imply endorsement.

Recommended attribution: **Meta_Kim by KimYx0207 — https://github.com/KimYx0207/Meta_Kim**
