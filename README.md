<div align="center">

# 元 · Meta_Kim

**Give your AI a goal. Keep the plan, the work and the next step connected.**

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

</div>

## Turn an idea into work you can follow and use

**Meta_Kim helps your AI assistant carry a project from “this needs to be better” to a result you can inspect, use and improve.** It works inside your existing AI client: it helps clarify the goal, choose an approach, organize the work, bring in relevant expertise and check what was actually delivered.

This matters when a job takes more than one prompt. A design decision affects implementation; one task needs another task's output; a later conversation needs to know what was finished. Meta_Kim keeps those connections in the project, so the next step can build on the work already done.

![Meta_Kim Live showing a task map and the progress of a demonstration workflow](docs/images/meta-kim-live-task.png)

*The actual Live interface with its built-in workflow demo. The map shows related tasks and their states; selecting a task reveals its records.*

## One project, from the first request to the next improvement

Suppose your website already has a sign-up form. It works, but on a phone the fields feel cramped and errors are hard to spot. You want an easier experience while keeping the same data fields.

**Describe the outcome in your own words.** The assistant first reads the existing flow and identifies what must stay: the data sent to the server, the required fields and the product's style. It can examine relevant references and compare approaches before changing the page. The questions it brings back should help make a real choice—for example, whether the form must stay on one screen.

**The approach becomes a connected plan.** At the project level, the plan records how the page, validation and server interface fit together. At the task level, it identifies the mobile layout changes, clearer error messages and checks needed to prove the same data still reaches the application. Each task has a scope, inputs, expected output and a way to judge completion. Independent work can proceed together; work that depends on an interface decision waits for that decision.

**You receive something you can try.** In this example, ask for the changed source, instructions for running it and the results of the checks. Try the flow at a phone-sized width: submit an empty field, enter an invalid value, then complete a normal sign-up. The result is compared with the agreed criteria. If the layout is better but an error still appears in the wrong place, the next task addresses that specific problem.

**The next conversation continues the same project.** You can say, “Keep this layout, but make the confirmation message clearer.” The recorded decisions, completed tasks and results provide the starting point. The assistant checks them against the current project before continuing.

![A goal becomes research, a plan, coordinated tasks, checks and the next improvement](docs/images/intent-to-delivery.svg)

A small repair can stay small. A feature that crosses several modules gets a more detailed plan. The amount of planning follows the work and its risks.

## Why the pieces keep working together

![How the user, AI client, Meta_Kim, specialist capabilities and project records work together](docs/images/meta-kim-overview.svg)

### A clear result gives every later choice a purpose

An initial request often mixes the problem, a possible solution and assumptions about the project. Meta_Kim helps separate them: what you want to achieve, what must be preserved and what would count as success. Research and references are brought in when they affect an important choice. That gives the assistant a reason for selecting an approach and gives you something concrete to review before substantial work begins.

### One design connects the whole system to individual tasks

For software work, the same design has two views. The **architecture view** describes the overall structure, interfaces and constraints. The **module view** turns it into tasks with clear responsibilities and acceptance criteria. A module's work therefore has a place in the overall result. When a decision changes, Meta_Kim can identify the affected tasks instead of treating every completed task as obsolete.

### Dependencies decide what can move forward

Tasks are organized by what they need and what they produce. Independent tasks can be assigned in parallel when the client provides the necessary tools; tasks sharing a prerequisite or a file must be coordinated. If one branch needs your decision, unrelated ready work can still continue. This makes the plan useful during execution, rather than a checklist that is forgotten once coding starts.

### Each task brings the expertise and materials it needs

Meta_Kim selects from the capabilities available in the client and from explicitly connected libraries such as Kim Service. A task can carry a specialist method, relevant references or an editable example together with its inputs and checks. Only the materials relevant to that task are loaded. The point is to give the worker enough context to produce the right result while keeping unrelated material out of its way.

### Project records give an interrupted task a place to resume

Plans, findings, progress and execution receipts connect the intended work to what actually happened. A later session can read them, compare them with the current files and identify the next step. If a previous operation's outcome is unclear, it first checks that outcome before repeating the operation. Valid completed work remains useful, even when the conversation or a particular task is interrupted.

### Checks lead to a specific correction

A task is complete when its outputs meet its criteria and the relevant checks support that conclusion. When the same approach repeatedly fails without changing the basis for the attempt, the affected task needs a reviewed correction: a different method, a revised assumption or a clearer decision. Useful findings can then inform the next improvement. You can see what was delivered, why it was accepted and what still needs work.

<a id="installation"></a>

## Start with your own project

You need **Node.js 22.13.0+**, Git and an AI client with its model connection configured. Current release: **[v3.10.2](https://github.com/KimYx0207/Meta_Kim/releases/tag/v3.10.2)**.

### 1. Install Meta_Kim

```bash
git clone https://github.com/KimYx0207/Meta_Kim.git
cd Meta_Kim
npm install
node setup.mjs
```

Choose your client, then choose the installation scope. **Global** installs reusable capabilities for your account; **project** installs for a project directory you select. Keep the Meta_Kim checkout for updates. Your working project can be a different directory.

For example, to install Codex support for one project directly:

```bash
node setup.mjs --targets codex --scope project --project-dir "/path/to/your-project"
```

Replace the quoted path with your project's absolute directory. For account-wide setup, use `--scope global` without `--project-dir`. You can select several clients with a comma-separated value such as `--targets codex,claude`.

You can also install without keeping a checkout: `npx --yes github:KimYx0207/Meta_Kim`; update later with `npx --yes github:KimYx0207/Meta_Kim update`. This route accepts the same setup options. For the CLI commands below, use that `npx` prefix in place of `node bin/meta-kim.mjs`.

### 2. Open your project and describe the result

Open the working project in the client you configured. Send an ordinary message:

> “Review this project's sign-up flow. Make it easier to use on a phone, preserve the current data fields, and show me the changed flow with its checks.”

Give the assistant the existing project and any constraints that matter. Review the important choices it presents, then let it work through the plan. You can ask what is changing, why it is changing and how the result will be checked. You do not need to remember an activation command.

### 3. Open Live and inspect the work

From the Meta_Kim checkout, run:

```bash
node bin/meta-kim.mjs live --project-root "/path/to/your-project"
```

Open the local URL printed by the command. Live reads that project's saved task and execution records. To explore the interface before you have project records, add `?demo=states` to the URL for the built-in demo shown here.

**Start with the task map** at the top of this page. Follow the connections to see what depends on what and which work is in progress. **Click a task**, then choose **Evidence** in its detail panel to inspect the recorded output and checks.

![A selected task in Meta_Kim Live with its details and recorded evidence](docs/images/meta-kim-live-detail.png)

*The built-in demo after selecting a task and opening its evidence. The panel helps explain the task's state through its records.*

Use the language selector for Chinese, English, Japanese or Korean. Live remembers the interface language and preserves the original wording of your tasks. Give new instructions and feedback in your AI client; use Live to follow and inspect the recorded work.

<a id="clients"></a>

## Use the client you already work in

The interactive installer supports these six target names. Choose one during setup, or use its name with `--targets`.

| Client | Target | What setup provides |
| --- | --- | --- |
| Claude Code | `claude` | Agents, Skills, commands and Hooks |
| Codex | `codex` | Agents, shared Skills, configuration and Hooks |
| Cursor | `cursor` | Agents, Skills, project rules and Hooks |
| OpenClaw | `openclaw` | Agent workspaces, Skills and a configuration template |
| Gemini CLI | `gemini` | Agents, shared Skills, settings and Hooks |
| ZCode | `zcode` | Agents, Skills, MCP configuration and optional user-level Hooks |

After installation, reopen the client in your working project so it loads the configuration. Tool access and model permissions remain controlled by that client. To enable Meta_Kim's global Hooks, add `--with-global-hooks` to the setup command; ZCode reads Hooks at the user level.

**OpenClaw also needs its template connected.** Setup produces the agent workspaces and `openclaw.template.json`—normally under `~/.openclaw/` for global setup, or `openclaw/` within a project installation. Merge the template's `agents.list` and `skills.load.extraDirs` into your existing OpenClaw configuration, preserving other agents, directories and settings. Restart the gateway and select `meta-warden` as the entry agent.

**Qoder and Trae** Beta adapter resources are included for experimental integration. They are inactive until explicitly configured and are not additional `--targets` options. DeepSeek Harness uses the separate setup below. Dependency projects maintain their own client support.

## Add Kim Service when the job needs specialist methods

Meta_Kim organizes the work. **Kim Service supplies reusable specialist methods and materials** for tasks such as design, analysis and content delivery. Connecting it lets Meta_Kim consider those methods when selecting how a task should be done; the task still runs through the tools available in your client.

If the installer has already registered a managed Service source and its installation record still verifies, Meta_Kim can use that registration. For a copy you download yourself, bind its directory explicitly as follows.

Clone Kim Service into a local directory:

```bash
git clone https://github.com/KimYx0207/Kim_Service.git
```

In **the working project's root**, create `.meta-kim/local.overrides.json` and point it to the absolute directory of that checkout:

```json
{
  "dependencyRoots": {
    "kim-service": "/absolute/path/to/Kim_Service"
  }
}
```

If this file already exists, merge the `kim-service` entry into its existing `dependencyRoots` object and preserve all other settings. Use the root of the project opened in your AI client, rather than the Meta_Kim installer directory. On Windows, forward slashes are valid in the JSON path, for example `C:/Projects/Kim_Service`.

For environment-managed setups, `META_KIM_KIM_SERVICE_ROOT` provides the same binding and takes precedence over the local file; set it in the environment that launches the AI client. Simply placing the two repositories beside each other does not connect them. Once the binding is present, ask the assistant to check available Kim Service capabilities and use the relevant method for your task.

<a id="dsh"></a>

## DeepSeek Harness setup

DSH has a separate Beta integration using its native profile, Skills and MCP configuration. With **DSH 0.2.2-rc.1** and **Node.js 24.9.0+** already installed, run these commands from the Meta_Kim checkout:

```bash
node bin/meta-kim.mjs dsh install
node bin/meta-kim.mjs dsh check
dsh --profile meta-kim
```

For one project, add `--scope project --project-root "/path/to/your-project"` to the install command, then use the launch command printed by the installer. Check that same project with:

```bash
node bin/meta-kim.mjs dsh check --scope project --project-root "/path/to/your-project"
```

To include Kim Service's native DSH Skills, download and unpack its DSH package from the [Kim Service releases](https://github.com/KimYx0207/Kim_Service/releases/latest), then add `--service-package "/path/to/unpacked-service-package"` when installing or updating.

Use `node bin/meta-kim.mjs dsh update` to refresh this integration. An update retains an existing Service projection; pass a new unpacked Service package when you want to update those Skills too. To remove the integration, run `node bin/meta-kim.mjs dsh uninstall`. For project updates or removal, supply the same `--scope project --project-root` values used at installation.

<a id="continue-work"></a>

## Continue, improve and keep the installation current

When a conversation is interrupted, reopen the **same working project** and ask the assistant to read its saved plan, findings, progress and execution records before continuing. For example:

> “Continue the sign-up improvement. Check the saved decisions and completed work against the current project, confirm the outcome of any interrupted operation, and carry on from the next unfinished task.”

For another iteration, say what to preserve and what should change: “Keep the mobile layout and the existing fields; improve the confirmation message.” This makes the new work build on the accepted result. An optional Memory service can help retain selected information across sessions; project task records already provide the basis for continuing the current work.

To update a source installation, run these commands in the Meta_Kim checkout:

```bash
git pull --ff-only
node setup.mjs --update
node setup.mjs --check
```

If installation or client loading needs attention, `node bin/meta-kim.mjs doctor` checks the setup and suggests the next step. Keep your working project's records when updating so later sessions can continue from them.

## Source and generated files

Shared Agents, Skills and runtime assets are maintained in `canonical/`, with machine-readable configuration in `config/`. Client directories such as `.claude/`, `.codex/` and `.cursor/` are generated locally by `npm run meta:sync`. These runtime projections are excluded from GitHub source and kept local through `.gitignore`; the distribution package includes their shared sources.

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
