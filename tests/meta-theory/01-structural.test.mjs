import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  SKILL_PATH,
  AGENTS_DIR,
  REFERENCE_DIR,
  ALL_AGENTS,
  ALL_TYPES,
  EIGHT_STAGES,
  REFERENCE_FILES,
  parseFrontmatter,
  readFile,
  readJson,
  fileExists,
} from "./_helpers.mjs";
import { promises as fs } from "node:fs";

/**
 * Extract the raw YAML block between --- delimiters, then parse
 * only the top-level scalar key: value lines. This avoids the
 * limitation of _helpers.parseFrontmatter which throws on YAML
 * list items (e.g. "  - shell" under the tools: key).
 */
function parseScalarFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (/^\s+-/.test(line)) continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key && value) {
      data[key] = value.replace(/^['"]|['"]$/g, "");
    }
  }
  return data;
}

function extractSecondLevelSection(markdown, heading) {
  const startToken = `## ${heading}`;
  const start = markdown.indexOf(startToken);
  if (start === -1) return null;

  const bodyStart = markdown.indexOf("\n", start);
  if (bodyStart === -1) return "";

  const rest = markdown.slice(bodyStart + 1);
  const nextHeading = rest.search(/\r?\n##[ \t]+/);
  const section =
    nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return section.trim();
}

let raw;
let frontmatter;

describe("SKILL.md structural integrity", async () => {
  raw = await fs.readFile(SKILL_PATH, "utf-8");
  frontmatter = parseScalarFrontmatter(raw);

  // ── 1. Frontmatter validity (7 tests) ──────────────────────────────

  describe("Frontmatter validity", () => {
    test("has valid YAML frontmatter with --- delimiters", () => {
      const hasDelimiters = /^---\r?\n[\s\S]*?\r?\n---/.test(raw);
      assert.ok(
        hasDelimiters,
        "SKILL.md must start with --- delimited YAML frontmatter",
      );
    });

    test("frontmatter.name === 'meta-theory'", () => {
      assert.equal(frontmatter.name, "meta-theory");
    });

    test("version matches semver pattern", () => {
      assert.match(
        frontmatter.version,
        /^\d+\.\d+\.\d+$/,
        `version "${frontmatter.version}" does not match semver X.Y.Z`,
      );
    });

    test("skill version remains 3.0.0 and does not add direct websearch tooling", () => {
      assert.equal(
        frontmatter.version,
        "3.0.0",
        "meta-theory skill version must not be confused with package release version",
      );
      assert.doesNotMatch(
        raw,
        /^\s+-\s+websearch\s*$/im,
        "meta-theory skill must route current-fact research through governance owners instead of adding a direct websearch tool",
      );
    });

    test("author is non-empty", () => {
      assert.ok(
        frontmatter.author && frontmatter.author.length > 0,
        "author field must be a non-empty string",
      );
    });

    test("trigger field contains both English and Chinese triggers", () => {
      const trigger = frontmatter.trigger || "";
      const hasChinese = /[\u4e00-\u9fff]/.test(trigger);
      const hasEnglish = /[a-zA-Z]/.test(trigger);
      assert.ok(
        hasChinese,
        "trigger must contain at least one Chinese trigger",
      );
      assert.ok(
        hasEnglish,
        "trigger must contain at least one English trigger",
      );
    });

    test("tools list exists", () => {
      assert.ok(
        raw.match(/^tools:\s*\r?\n(\s+-\s+\w+\r?\n?)+/m),
        "frontmatter must contain a tools list",
      );
    });

    test("description field exists", () => {
      assert.ok(
        raw.match(/^description:\s*\|?\s*\r?\n/m),
        "frontmatter must contain a description field",
      );
    });
  });

  // ── 2. Five Type flows documented (5 tests) ────────────────────────

  describe("Five Type flows documented", () => {
    for (const type of ALL_TYPES) {
      test(`Type ${type} heading exists in SKILL.md`, () => {
        const pattern = new RegExp(`^##\\s+Type\\s+${type}:`, "m");
        assert.ok(
          pattern.test(raw),
          `SKILL.md must contain a '## Type ${type}:' heading`,
        );
      });
    }
  });

  // ── 3. Both gates documented (2 tests) ─────────────────────────────

  describe("Both gates documented", () => {
    test("Gate 1: Clarity Check is documented", () => {
      assert.ok(
        raw.includes("Gate 1") && raw.includes("Clarity Check"),
        "SKILL.md must document Gate 1: Clarity Check",
      );
    });

    test("Gate 2: Dispatch-Not-Execute is documented", () => {
      assert.ok(
        raw.includes("Gate 2") && raw.includes("Dispatch-Not-Execute"),
        "SKILL.md must document Gate 2: Dispatch-Not-Execute",
      );
    });
  });

  // ── 4. Meta agent dispatch targets (1 test) ───────────────────────

  describe("Agent dispatch targets", () => {
    test("all expected meta-agents are referenced in SKILL.md", () => {
      const missing = ALL_AGENTS.filter((agent) => !raw.includes(agent));
      assert.deepEqual(
        missing,
        [],
        `SKILL.md is missing references to: ${missing.join(", ")}`,
      );
    });
  });

  // ── 5. Reference files exist (1 test with subtests) ────────────────

  describe("Reference files exist", () => {
    for (const file of REFERENCE_FILES) {
      test(`references/${file} exists`, async () => {
        const exists = await fileExists(
          `canonical/skills/meta-theory/references/${file}`,
        );
        assert.ok(exists, `Reference file references/${file} must exist`);
      });
    }
  });

  describe("Progressive disclosure boundaries", () => {
    test("SKILL.md delegates specialized detail through the reference index", () => {
      const referenceSection = extractSecondLevelSection(raw, "Reference loading");
      assert.ok(referenceSection, "SKILL.md must keep one explicit reference-loading boundary");
      for (const file of REFERENCE_FILES) {
        assert.ok(
          referenceSection.includes(`\`${file}\``),
          `Reference loading must route specialized detail to ${file}`,
        );
      }
      assert.doesNotMatch(
        raw,
        /```json\s*\{\s*"\$schema"/,
        "SKILL.md must not inline machine schemas instead of delegating to contracts/references",
      );
    });

    test("SKILL.md does not document stale packet field names", () => {
      for (const stale of [
        "workerTaskPackets[].fileCompletionList",
        "metaReviewPacket",
        "verificationResults.fixEvidence",
      ]) {
        assert.ok(
          !raw.includes(stale),
          `SKILL.md must not contain stale packet field name ${stale}`,
        );
      }
      assert.ok(raw.includes("workerResultPackets[].fileCompletionList"));
      assert.ok(raw.includes("workerExecutionEvidence"));
      assert.ok(raw.includes("verificationPacket.fixEvidence"));
    });

    test("stage DAG is authoritative and agent-teams-playbook is optional", () => {
      assert.match(raw, /coreLoop\.stageDagPacket[\s\S]{0,240}runtime authority/i);
      assert.match(raw, /maximal safe ready set/i);
      assert.match(raw, /agent-teams-playbook[\s\S]{0,180}optional/i);
      assert.match(raw, /never a prerequisite for safe native fan-out/i);
      assert.doesNotMatch(
        raw,
        /Apply `agent-teams-playbook`[\s\S]{0,80}before substantive work/i,
      );
    });

    test("runtime command does not force agent-teams-playbook for all non-trivial work", async () => {
      const command = await readFile("canonical/runtime-assets/codex/commands/meta-theory.md");
      assert.match(command, /authoritative stage DAG[\s\S]{0,120}native `spawn_agent`/i);
      assert.match(command, /agent-teams-playbook[\s\S]{0,80}optional/i);
      assert.match(command, /optional_adapter_not_selected/i);
      assert.doesNotMatch(command, /For any non-trivial task,\s*first apply `agent-teams-playbook`/i);
    });

    test("Codex /meta-theory command surfaces governed output and uses the adaptive top-level spawn contract", async () => {
      const command = await readFile("canonical/runtime-assets/codex/commands/meta-theory.md");
      const pkg = await readJson("package.json");
      assert.match(command, /__META_KIM_PACKAGE_ROOT__\/scripts\/run-meta-theory-governed-execution\.mjs/);
      assert.match(command, /--runtime codex/);
      assert.match(command, /meta:theory:run:notice -- --runtime codex "\$ARGUMENTS"/);
      assert.match(command, /localized stderr progress snapshots/i);
      assert.match(command, /stdout as the single final machine-readable JSON summary/i);
      assert.match(command, /Windows\/npm paths strip forwarded flags/i);
      assert.match(pkg.scripts["meta:theory:run:notice"], /--emit-conversation-notice/);
      assert.match(command, /top-level `spawn_agent`/i);
      assert.match(command, /`task_name`/);
      assert.match(command, /`message`/);
      assert.match(command, /`fork_turns`/);
      assert.match(command, /ownerBindingMode=native_custom_agent/i);
      assert.match(command, /active schema exposes `agent_type`/i);
      assert.match(command, /run_scoped_owner_contract/i);
      assert.match(command, /omit `nativeAgentType`\/`agent_type`/i);
      assert.doesNotMatch(command, /fork_context/);
      assert.match(command, /Do not discover or fall back to a legacy namespaced spawn API/);
      assert.doesNotMatch(command, /multi_agent_v1\.spawn_agent/);
    });

    test("Codex runtime reference uses the adaptive top-level spawn task contract", async () => {
      const reference = await readFile("canonical/skills/meta-theory/references/runtime-codex.md");
      assert.match(reference, /Codex global or project owners?/);
      assert.match(reference, /top-level `spawn_agent`/);
      assert.match(reference, /`task_name`/);
      assert.match(reference, /`message`/);
      assert.match(reference, /`fork_turns`/);
      assert.match(reference, /Select `native_custom_agent`/i);
      assert.match(reference, /schema-confirmed `agent_type`/i);
      assert.match(reference, /run_scoped_owner_contract/i);
      assert.match(reference, /omit `nativeAgentType`\/`agent_type`/i);
      assert.doesNotMatch(reference, /fork_context/);
      assert.doesNotMatch(reference, /multi_agent_v1\.spawn_agent/);
    });

    test("Claude Code /meta-theory command passes Claude runtime and requires live Agent Task dispatch", async () => {
      const command = await readFile("canonical/runtime-assets/claude/commands/meta-theory.md");
      const settings = await readJson("canonical/runtime-assets/claude/settings.json");
      assert.match(command, /__META_KIM_PACKAGE_ROOT__\/scripts\/run-meta-theory-governed-execution\.mjs/);
      assert.match(command, /--runtime claude_code/);
      assert.match(command, /meta:theory:run:notice -- --runtime claude_code "\$ARGUMENTS"/);
      assert.match(command, /HOST-NATIVE FAN-OUT PREFERRED/i);
      assert.match(command, /hostInvocationRequestPacket/);
      assert.match(command, /agent-teams-playbook/);
      assert.ok(command.includes("real `Agent` / Task surface"));
      assert.ok(command.includes("workerTaskPackets[].taskPacketId"));
      assert.match(command, /tool-call id/i);
      assert.match(command, /do not silently continue as main-thread execution/i);
      const preToolMatchers = (settings.hooks?.PreToolUse ?? []).map((entry) => entry.matcher ?? "");
      assert.ok(preToolMatchers.some((matcher) => /(?:^|\|)Agent(?:\||$)/.test(matcher)));
      assert.ok(preToolMatchers.some((matcher) => /(?:^|\|)Task(?:\||$)/.test(matcher)));
    });

    test("agent-teams-playbook provider discovery is runtime-specific and prefers the local dependency checkout over stale global installs", async () => {
      const runner = await readFile("scripts/run-meta-theory-governed-execution.mjs");
      assert.match(runner, /source: "project_claude_skill"/);
      assert.match(runner, /source: "claude_global_skill"/);
      assert.match(runner, /source: "project_codex_skill"/);
      assert.match(runner, /source: "codex_global_skill"/);
      assert.match(runner, /resolveAgentTeamsPlaybookProvider\(routeRuntime\)/);
      assert.match(
        runner,
        /source: "sibling_dependency_checkout"[\s\S]{0,400}\.\.\.runtimeGlobalCandidates/,
        "sibling dependency checkout must win over stale runtime-global installs during local development",
      );
      assert.equal(
        /providerResolution\?\.configuredInSkills === true[\s\S]{0,120}providerAvailable/.test(runner),
        false,
        "configured/registered metadata alone must not make the playbook callable",
      );
    });

    test("Codex fork_context parameter stays out of shared and non-Codex runtime surfaces", async () => {
      const nonCodexSurfaces = [
        "canonical/skills/meta-theory/SKILL.md",
        "canonical/skills/meta-theory/references/dev-governance.md",
        "canonical/runtime-assets/claude/commands/meta-theory.md",
        "canonical/runtime-assets/cursor/rules/meta-theory-dispatch.mdc",
        "canonical/runtime-assets/openclaw/DECLARED_GAP.md",
      ];
      for (const rel of nonCodexSurfaces) {
        const text = await readFile(rel);
        assert.doesNotMatch(text, /fork_context/);
        assert.doesNotMatch(text, /Never pass `fork_context: true` together with `agent_type`/);
      }
    });

    test("governed runner routes through the requested runtime instead of hardcoding Codex", async () => {
      const runner = await readFile("scripts/run-meta-theory-governed-execution.mjs");
      assert.match(runner, /argValue\("--runtime"/);
      assert.match(runner, /normalizeRouteRuntime\(runtimeArg\)/);
      assert.match(runner, /SELECT_EXECUTION_ROUTE_SCRIPT/);
      assert.match(runner, /"--runtime",\s*routeRuntime/);
      assert.match(runner, /runtimeFamily: routeRuntime/);
      assert.match(runner, /hostInvocationRequestPacket/);
      assert.match(runner, /runtimeInvocationPlanPacket/);
      assert.match(runner, /selected_not_invoked/);
      assert.match(runner, /routeRuntime/);
    });

    test("SKILL.md preserves product reasoning, ten-x path challenge, and user-facing closure", () => {
      assert.match(raw, /Product Reasoning Contract/i);
      assert.match(raw, /surface request/i);
      assert.match(raw, /real product problem/i);
      assert.match(raw, /minimal fix/i);
      assert.match(raw, /ten-x|10x|ten-times/i);
      assert.match(raw, /path shift/i);
      assert.match(raw, /chosen rationale/i);
      assert.match(raw, /why.*changed|why.*change/i);
      assert.match(raw, /what changed|where changed/i);
      assert.match(raw, /user impact/i);
      assert.match(raw, /verification/i);
    });

    test("SKILL.md requires compact human-readable stage feedback", () => {
      assert.match(raw, /Human-Readable Stage Feedback/i);
      assert.match(raw, /Critical.*Fetch.*Thinking.*Review/s);
      assert.match(raw, /human/i);
      assert.match(raw, /user.*language|detected user language|resolved user language/i);
      assert.match(raw, /token/i);
      assert.match(raw, /debug/i);
      assert.match(raw, /packet/i);
      assert.match(raw, /field name|internal keys/i);
      assert.match(raw, /human label|human-readable label|user-facing output/i);
      assert.match(raw, /Record internally/i);
    });

    test("SKILL.md routes natural-language governed entry through Warden entry gate and evidence owners", () => {
      assert.match(raw, /Warden Entry Gate/i);
      assert.match(raw, /ordinary natural-language durable work/i);
      assert.match(raw, /Governed meta-theory entry[\s\S]{0,220}meta-warden/i);
      assert.match(raw, /ordinary natural language[\s\S]{0,160}explicit maintainer shortcut/i);
      assert.match(raw, /meta-warden[\s\S]{0,180}entry gate/i);
      assert.match(raw, /meta-conductor[\s\S]{0,220}evidence lane/i);
      assert.match(raw, /meta-scout[\s\S]{0,220}external evidence/i);
      assert.match(raw, /meta-prism[\s\S]{0,220}Critical[\s\S]{0,120}Fetch[\s\S]{0,120}Thinking/i);
    });

    test("Fetch rules require material-claim extraction and blocked current-fact handling", () => {
      assert.match(raw, /material claims/i);
      assert.match(raw, /version/i);
      assert.match(raw, /price/i);
      assert.match(raw, /third-party|platform|tool/i);
      assert.match(raw, /contentEvidencePacket\.researchRequired\s*=\s*true/i);
      assert.match(raw, /researchCapabilityDiscovery/i);
      assert.match(raw, /web_search|url_fetch|docs_lookup|browser_open/i);
      assert.match(raw, /blocked|user_fallback/i);
      assert.doesNotMatch(raw, /Key Information Extraction And Online Verification/i);
    });
  });

  // ── 6. Contract files (3 tests) ────────────────────────────────────

  describe("Contract files", () => {
    test("workflow-contract.json exists and is valid JSON", async () => {
      const exists = await fileExists(
        "config/contracts/workflow-contract.json",
      );
      assert.ok(exists, "config/contracts/workflow-contract.json must exist");
      const data = await readJson("config/contracts/workflow-contract.json");
      assert.equal(
        typeof data,
        "object",
        "workflow-contract.json must parse to an object",
      );
      assert.ok(data !== null, "workflow-contract.json must not be null");
    });

    test("evolution-contract.json exists and is valid JSON", async () => {
      const exists = await fileExists(
        "config/contracts/evolution-contract.json",
      );
      assert.ok(exists, "config/contracts/evolution-contract.json must exist");
      const data = await readJson("config/contracts/evolution-contract.json");
      assert.equal(
        typeof data,
        "object",
        "evolution-contract.json must parse to an object",
      );
      assert.ok(data !== null, "evolution-contract.json must not be null");
    });

    test("scar-protocol.md exists", async () => {
      const exists = await fileExists("config/contracts/scar-protocol.md");
      assert.ok(exists, "config/contracts/scar-protocol.md must exist");
    });
  });
});

describe("Canonical meta-agent boundary structure", () => {
  const longTermProviders = [
    "meta-theory",
    "agent-teams-playbook",
    "findskill",
    "superpowers",
    "ecc",
  ];

  for (const agent of ALL_AGENTS) {
    test(`${agent} declares the unified 8-stage position matrix`, async () => {
      const rawAgent = await readFile(`canonical/agents/${agent}.md`);
      const matrix = extractSecondLevelSection(
        rawAgent,
        "8-Stage Position Matrix",
      );

      assert.ok(matrix, `${agent} must contain ## 8-Stage Position Matrix`);

      for (const field of [
        "Primary stage",
        "Conditional stages",
        "Must not execute in",
        "Handoff owner",
      ]) {
        assert.ok(matrix.includes(field), `${agent} matrix missing ${field}`);
      }

      assert.ok(
        EIGHT_STAGES.some((stage) => matrix.includes(stage)),
        `${agent} matrix must reference at least one canonical 8-stage label`,
      );
    });

  }

  test("Long-term capability policy uses abstract slots and run-only concrete skill selection", async () => {
    const contract = await readJson("config/contracts/workflow-contract.json");
    const index = await readJson("config/capability-index/meta-kim-capabilities.json");
    const policy =
      contract.protocols?.agentBlueprintPacket?.longTermCapabilityPolicy ?? {};

    assert.equal(policy.abstractCapabilitySlotsRequired, true);
    assert.equal(policy.forbidConcreteSkillInLongTermAgentIdentity, true);
    assert.equal(policy.selectedSkillScope, "run_only");
    assert.equal(index.runtimeSelectedSkills?.selectedSkillScope, "run_only");
    assert.ok(Array.isArray(index.abstractCapabilitySlots));
    assert.ok(index.abstractCapabilitySlots.length >= 1);

    for (const provider of longTermProviders) {
      assert.ok(
        policy.allowedMetaSkillProviders?.includes(provider),
        `workflow contract must allow provider package ${provider}`,
      );
      assert.equal(
        index.metaSkillProviders?.[provider]?.allowedForLongTermAgentIdentity,
        true,
        `capability index must allow provider package ${provider}`,
      );
    }
  });

  test("Long-term identity policy rejects concrete child skills while allowing provider packages", async () => {
    const index = await readJson("config/capability-index/meta-kim-capabilities.json");
    const forbiddenConcreteBindings = [
      /superpowers\/[a-z0-9_-]+/i,
      /gstack\/[a-z0-9_-]+/i,
      /everything-claude-code:[a-z0-9_-]+/i,
    ];
    const allowedProviderIdentity =
      "Allowed meta-skill package providers: meta-theory, agent-teams-playbook, findskill, superpowers, ecc";
    const fixedConcreteIdentity =
      "Dependency Skill Invocations: superpowers/test-driven-development, gstack/qa, everything-claude-code:code-reviewer";

    for (const provider of longTermProviders) {
      assert.ok(
        allowedProviderIdentity.includes(provider),
        `provider package ${provider} should be allowed in long-term identity`,
      );
    }
    for (const pattern of forbiddenConcreteBindings) {
      assert.ok(
        !pattern.test(allowedProviderIdentity),
        `provider-only identity must not match concrete child-skill pattern ${pattern}`,
      );
      assert.ok(
        pattern.test(fixedConcreteIdentity),
        `concrete child-skill identity must be rejected by ${pattern}`,
      );
    }
    assert.equal(
      index.longTermAgentIdentityPolicy?.forbidConcreteSkillInLongTermAgentIdentity,
      true,
    );
  });

  test("Warden boundary uses decision/arbitration language, not Prism review language", async () => {
    const warden = await readFile("canonical/agents/meta-warden.md");
    assert.ok(
      warden.includes("Quality Gate decision / arbitration"),
      "meta-warden must own Quality Gate decision / arbitration",
    );
    assert.ok(
      !warden.includes("Quality Gate review"),
      "meta-warden must not claim Quality Gate review",
    );
  });

  test("Conductor assigns dispatch board schema validation without taking Stage 7 ownership", async () => {
    const conductor = await readFile("canonical/agents/meta-conductor.md");
    assert.ok(
      conductor.includes("dispatch board schema validation"),
      "meta-conductor must assign dispatch board schema validation",
    );
    assert.ok(
      conductor.includes("Stage 7 Verification owner remains `meta-warden + meta-prism`"),
      "meta-conductor must preserve Warden + Prism as Stage 7 Verification owner",
    );
    assert.ok(
      !conductor.includes("| **Verification Owner** | `npm run meta:validate` |"),
      "meta-conductor must not name npm run meta:validate as the Verification Owner",
    );
  });

  test("Evolution writeback authority is uniform across canonical agents", async () => {
    const files = await fs.readdir(AGENTS_DIR);
    const agentFiles = files.filter((file) => file.endsWith(".md"));
    const bad = [];

    for (const file of agentFiles) {
      const rawAgent = await readFile(`canonical/agents/${file}`);
      if (
        rawAgent.includes("write back directly to this agent") ||
        rawAgent.includes("directly to canonical") ||
        rawAgent.includes("直接写back")
      ) {
        bad.push(file);
      }
      assert.ok(
        rawAgent.includes(
          "Warden approves; Chrysalis coordinates; target specialist performs writeback",
        ),
        `${file} must state the uniform evolution writeback authority`,
      );
    }

    assert.deepEqual(bad, [], `Direct-writeback wording remains in: ${bad.join(", ")}`);
  });

  test("oversized meta-theory references are split below operational size limits", async () => {
    const entries = await fs.readdir(REFERENCE_DIR, { withFileTypes: true });
    const tooLarge = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const content = await fs.readFile(`${REFERENCE_DIR}/${entry.name}`, "utf-8");
      const lines = content.split(/\r?\n/).length;
      if (lines > 650) tooLarge.push(`${entry.name}:${lines}`);
    }
    assert.deepEqual(
      tooLarge,
      [],
      `Reference files over 650 lines should be split: ${tooLarge.join(", ")}`,
    );
  });

  test("meta-conductor makes native stage-DAG fan-out sufficient", async () => {
    const conductor = await readFile("canonical/agents/meta-conductor.md");
    assert.match(conductor, /authoritative stage DAG[\s\S]{0,180}native Agent\/Task\/`spawn_agent`/i);
    assert.match(conductor, /agent-teams-playbook[\s\S]{0,120}optional/i);
    assert.match(conductor, /never a prerequisite for fan-out/i);
    assert.doesNotMatch(
      conductor,
      /At the start of Stage 4 \(Execution\), use the `agent-teams-playbook` provider package/i,
    );
  });

  test("meta-artisan uses runtime-aware capability discovery instead of Claude-only scans", async () => {
    const artisan = await readFile("canonical/agents/meta-artisan.md");
    assert.match(artisan, /canonical capability index[\s\S]{0,160}runtime mirrors[\s\S]{0,160}local runtime inventory/i);
    assert.doesNotMatch(artisan, /Scan `\.claude\/agents\/\*\.md`/);
    assert.doesNotMatch(artisan, /Scan `\.claude\/skills\/\*\/SKILL\.md`/);
  });

  test("meta-theory references do not present Claude runtime mirrors as canonical instructions", async () => {
    for (const rel of [
      "canonical/skills/meta-theory/references/create-agent.md",
      "canonical/skills/meta-theory/references/rhythm-orchestration.md",
      "canonical/skills/meta-theory/references/ten-step-governance.md",
    ]) {
      const content = await readFile(rel);
      assert.doesNotMatch(
        content,
        /(?:Read|See|Generate|lives in)\s+`\.claude\/agents\//i,
        `${rel} should route through canonical source first, then runtime mirror`,
      );
    }
  });
});
