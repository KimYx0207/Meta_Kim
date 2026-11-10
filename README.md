<div align="center">

# 元 · Meta_Kim

**From a rough idea to work you can follow and verify.**

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

<a href="https://github.com/KimYx0207/Meta_Kim/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/KimYx0207/Meta_Kim?style=flat"/></a>
<a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-green"/></a>

<a href="config/runtime-compatibility-catalog.json"><img alt="Default: Claude Code and Codex; compatibility: OpenClaw and Cursor" src="https://img.shields.io/badge/default-Claude%20Code%20%7C%20Codex%20%2B%20compat--OpenClaw%20%7C%20Cursor-111827"/></a>
<a href="config/runtime-compatibility-catalog.json"><img alt="Opt-in projections: Gemini CLI and ZCode" src="https://img.shields.io/badge/opt--in-Gemini%20CLI%20%7C%20ZCode-4F46E5"/></a>

</div>

## What is it?

**Meta_Kim is a harness for your AI coding assistant: it helps turn a rough request into decisions, a shared plan, coordinated work and results you can inspect.** It runs through your selected host. You describe what you want; Meta_Kim organizes the work around that outcome.

Use it for work that spans decisions, files, specialties or multiple sessions: developing a product, changing an existing system, researching an approach or coordinating a substantial repair. A small, clear change takes a lighter path.

> “I want a registration tool. People should sign up from their phones, and I need a reliable list of attendees. Work out the options with me, then build and verify the chosen approach.”

![How Meta_Kim connects an idea, research, the two PRD views, professional capabilities and verified delivery](docs/images/intent-to-delivery.svg)

*Architecture illustration. Actual scheduling depends on the current host, task dependencies, permissions and verification evidence.*

## What you get

| Step | What you can see |
| --- | --- |
| Understand | The intended outcome, existing project facts, constraints and open questions |
| Research and decide | Relevant sources, feasible options, a recommendation and practical tradeoffs |
| Design | One PRD: first the system and technology baseline, then modules, interfaces, states and acceptance |
| Coordinate | Named owners with the selected methods and materials; independent eligible work can run concurrently |
| Review and verify | Actual deliverables, fresh checks, failures and remaining gaps |
| Continue and improve | Settled decisions and completed work survive interruptions; reviewed lessons can become reusable improvements |

**You choose product direction when it matters.** The host selects internal agents and tools from observed capabilities. Word overlap recalls candidates; it does not prove that an agent fits the job.

### Meta_Kim + Kim Service

| Project | Responsibility |
| --- | --- |
| **[Meta_Kim](https://github.com/KimYx0207/Meta_Kim)** | Understand, research, decide, coordinate, review, verify and maintain continuity |
| **[Kim Service](https://github.com/KimYx0207/Kim_Service)** | Reusable professional Agents, Skills, Hooks and Tools with methods, examples and input/output boundaries |

A frontend agent needs design and engineering knowledge, project constraints and actual task material. The integration loads selected package resources, checks their bytes and includes them in the worker handoff. A role title or successful schema check alone cannot establish professional quality.

## Start in three steps

Requires **Node.js 22.13.0 or newer** and a supported host configured by you.

**1. Install from the repository.**

```bash
git clone https://github.com/KimYx0207/Meta_Kim.git
cd Meta_Kim
npm install
node setup.mjs
```

Choose the clients you use. The default install reuses capabilities globally; project-specific overrides use the existing project bootstrap. Global Hooks are opt-in with `--with-global-hooks`. Existing user configuration is merged through ownership-aware installation records.

For an npx entry, use `npx --yes github:KimYx0207/Meta_Kim`. Persistent runtime assets are materialized into a stable package store so they do not depend on the disposable npm cache.

**2. Open your project in the selected host and describe the outcome.**

You do not need to memorize commands or choose technical roles. Say what should work, what must be preserved and how you will judge the result. The host inspects available project evidence and asks only material unresolved questions.

**3. Follow the work and inspect the result.**

Use the Live link supplied for the current project/run, or `node bin/meta-kim.mjs live`. The view shows task ownership, dependencies, outputs and blockers from the same underlying records.

![Meta_Kim Live work board using representative demo data](docs/images/meta-kim-live-demo.png)

*The real Live renderer with representative demo data. A returned tool call, a passed check and an accepted product result are separate states.*

### Updating a clone

```bash
git pull --ff-only
node setup.mjs --update
```

Check your selected installation with `node setup.mjs --check`. Local edits and unverified historical files are preserved for review. Source updates, dependency updates and native host verification have separate results.

## Client support: what is implemented and what is verified

The released baseline is [v3.9.0](https://github.com/KimYx0207/Meta_Kim/releases/tag/v3.9.0). Additions described in [Unreleased](CHANGELOG.md#unreleased) belong to the source version and have not been published as a new release.

| Client | Current source integration | Evidence boundary |
| --- | --- | --- |
| **Codex** | Primary formal projections; native instructions, agents, skills, Hook/config integration and read-only execution bridge | Availability and execution depend on the active host and current evidence |
| **Claude Code** | Primary formal projections; native Agent/Skill/Hook integration and read-only execution bridge | Its native tool contract is maintained separately from Codex |
| **Cursor** | Non-default compatibility projections for rules, skills, agents and supported config | Projection checks do not certify every native workflow |
| **Gemini CLI** | Opt-in native projection with agents, shared host-neutral skills and native settings/Hooks | Structural/lifecycle validation; native model execution remains unverified |
| **ZCode** | Opt-in native projection with agents, skills, MCP and user-level Hooks | Project Hooks are ignored by the current client; native model execution remains unverified |
| **OpenClaw** | Existing non-default compatibility projections | Requires its own configuration and host evidence |

DeepSeek Harness, Qoder and Trae remain **Beta compatibility adapters** outside normal native projection. ZCode's historical plan-only adapter remains separate from its new opt-in projection. See the [compatibility catalog](config/runtime-compatibility-catalog.json) and the [Gemini](canonical/skills/meta-theory/references/runtime-gemini.md) / [ZCode](canonical/skills/meta-theory/references/runtime-zcode.md) references.

Dependency-project install targets are handled by those upstream projects. Installing an upstream package does not certify Meta_Kim support. Gemini and Codex share host-neutral project skills; the active host determines paths and tool schemas. [Gemini's skill discovery](https://geminicli.com/docs/cli/skills/) and [ZCode's Hook configuration rules](https://zcode.z.ai/en/docs/hooks) explain these client-specific boundaries.

## How continuity and improvement work

Architecture and modules are views of **one PRD**, linked to the same tasks and acceptance criteria. A module change follows actual dependencies; unaffected completed outputs can be considered for reuse after their current bindings are checked.

The durable read-only executor takes the smaller of observed host capacity and planned capacity, starts eligible independent work, and fills a freed slot when dependencies become ready. Unknown capacity defaults to one. Global stage barriers and write permissions remain in force.

Human acceptance is local to the affected branch: A can wait while independent B/C continue. Completed work is retained on resume, and final delivery still waits for every required gate. The Live view shows pending acceptance separately from independent work.

Optional dependencies are selected for the capability they add. Repeated workflow prompts are consolidated into the existing first-party method; browser, desktop and other execution engines retain their own interfaces. See the [architecture and capability model](docs/harness-architecture.md).

RSI is a measured improvement loop: observed work → candidate method → evaluation → reviewed promotion. Missing quality observations remain unevaluated. A reflection, score or evidence filename cannot approve its own change. Instruction changes invalidate fitness-trial reuse; historical results do not certify a new scaffold.

Current source navigation helps locate callers and related files even without Graphify. Static absence of references is a cleanup lead; dynamic imports, configuration, generated consumers and external entry points require inspection before removal.

### Optional memory: check what actually works

If you enabled the optional Memory service, its default local health endpoint can be checked with:

```bash
curl -fsS --max-time 3 http://127.0.0.1:8000/api/health
```

Use your configured address if you changed it. An entry in `.mcp.json`, an installed hook or health checks alone cannot prove successful memory writes, reads or cross-session recall; each needs a fresh receipt from that operation. `npm run meta:test:mcp` checks Meta_Kim's own MCP server contract, not those external Memory operations. Memory is optional and does not replace the project's durable run records.

## Find the right file

| Location | Purpose |
| --- | --- |
| `canonical/` | Source governance agents, skills, rules and runtime assets |
| `config/` | Contracts, compatibility declarations and evidence |
| `scripts/` · `src/` | Execution, validation, adapters, storage and user-facing tools |
| `tests/` | Behavior and regression checks; fixtures identify their evidence limits |
| Generated client directories | Local projections rebuilt from canonical sources |
| `.meta-kim/` | Private run state, project planning, evidence and backups |

Read [intent to delivery](canonical/skills/meta-theory/references/intent-to-delivery.md) for the full workflow and research decisions, [project/research/PRD](canonical/skills/meta-theory/references/project-research-prd.md) for the data flow, and [AGENTS.md](AGENTS.md) before contributing. The existing eight-stage spine remains the governing process.

Generated runtime projection directories are local outputs, gitignored, and not GitHub source.

Useful maintainer commands:

```bash
npm run meta:sync
npm run meta:validate
npm run meta:test:ci -- --suite core
npm run meta:test:ci -- --suite governance
```

A local test pass proves only what that check exercised. Native CLI observations, model quality and final user acceptance need their own evidence. See [native CLI observation and privacy](docs/native-cli-observation.md), [Live SDK](docs/live-sdk.md), [Graphify lifecycle](docs/graphify-managed-lifecycle.md) and the [changelog](CHANGELOG.md).

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
