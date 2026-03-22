import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildDepartmentMatrix,
  departmentOrchestration,
  departmentTemplates,
  flagshipSelectionByIndustry,
  industries,
  specialistTemplatesByDepartment,
} from "../factory/catalog/foundry-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(repoRoot, "factory", "generated");
const checkOnly = process.argv.includes("--check");

function dedupe(list) {
  return [...new Set(list)];
}

function toBullets(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

function renderLinkList(items) {
  return items.map((item) => `- \`${item}\``).join("\n");
}

function buildMission(industry, department) {
  return `Operate as the ${industry.name} ${department.title}, helping teams ${industry.thesis}.`;
}

function buildExpectedInputs(industry, department) {
  return dedupe([...industry.inputs, ...department.inputs]);
}

function buildDeliverables(industry, department) {
  return dedupe([...department.outputs, ...industry.outputs]);
}

function buildExpertLenses(industry, department, specialist = null) {
  return dedupe([
    ...industry.expertLenses,
    ...department.expertLenses,
    ...(specialist?.expertLenses ?? []),
  ]);
}

function buildMentalModels(industry, department, specialist = null) {
  return dedupe([
    ...industry.mentalModels,
    ...department.mentalModels,
    ...(specialist?.thinking ?? []),
  ]);
}

function buildToolTargets(industry, department, specialist = null) {
  return dedupe([
    ...industry.toolTargets,
    ...department.toolTargets,
    ...(specialist?.toolFocus ?? []),
  ]);
}

function buildGuardrails(industry) {
  return [
    "Use named experts as thinking references, not as impersonation targets.",
    "Do not claim to have used tools or data sources that were not actually provided.",
    "Make assumptions explicit before turning them into recommendations.",
    ...industry.guardrails,
  ];
}

function toSentenceCase(input) {
  if (!input) return input;
  return input.charAt(0).toUpperCase() + input.slice(1);
}

function buildSpecialistOwns(agent, specialist, deliverables) {
  return dedupe([
    specialist.mandate,
    `The ${specialist.title} slice inside ${agent.department.title}.`,
    ...deliverables.slice(0, 4).map((item) => `Own the ${item}.`),
  ]).map((item) => item.endsWith(".") ? item : `${toSentenceCase(item)}.`);
}

function buildSpecialistRefuses(agent, specialist) {
  return [
    `Do not absorb the full ${agent.department.title} scope when this specialist slice is enough.`,
    "Do not arbitrate cross-department conflicts alone.",
    "Do not fake evidence, user signal, or tool usage.",
    `Do not widen beyond ${specialist.title} just because adjacent work exists.`,
  ];
}

function buildSpecialistActivationSignals(agent, specialist, expectedInputs, deliverables) {
  return [
    `The team needs ${specialist.title.toLowerCase()} work inside ${agent.industry.name} ${agent.department.title}.`,
    `The parent department cannot move forward until someone owns ${deliverables[0] ?? "a specialist-grade deliverable"}.`,
    `The task needs sharper handling of ${expectedInputs[0] ?? "critical inputs"} before a broader decision is safe.`,
    "The team needs a narrow specialist judgment instead of a generic department-level answer.",
  ];
}

function buildSpecialistDecisionRules(agent, specialist, expectedInputs, deliverables) {
  return [
    `If the task no longer fits ${specialist.title}, hand it back to \`${agent.id}\` instead of stretching scope.`,
    `If key inputs such as ${expectedInputs.slice(0, 2).join(" and ")} are missing, state the gap before acting confident.`,
    `If the requested output goes beyond ${deliverables.slice(0, 2).join(" and ")}, separate what this specialist can do from what needs another owner.`,
    "If assumptions drive the recommendation, write the assumptions explicitly instead of hiding them.",
    "If a cross-department dependency appears, escalate rather than silently taking over adjacent work.",
  ];
}

function buildSpecialistQualityBar(specialist, deliverables) {
  return [
    `Produces specialist-grade outputs such as ${deliverables.slice(0, 2).join(" and ")} instead of generic advice.`,
    "Names assumptions, uncertainty, and breakpoints clearly.",
    "Stays narrow enough to be trustworthy, but concrete enough to be executable.",
    "Leaves the parent department with something usable for the next decision.",
  ];
}

function buildSpecialistHandoffRules(agent, specialist) {
  return [
    `Return conclusions, artifacts, and unresolved gaps to \`${agent.id}\`.`,
    `If the work collides with sibling specialists, ask ${agent.department.title} to coordinate the next handoff.`,
    "Escalate cross-department collisions to `meta-warden` instead of improvising governance.",
    `Keep the specialist role sharp: ${specialist.title} should enrich the parent department, not replace it.`,
  ];
}

function buildSpecialistAntiSlop(specialist) {
  return [
    `Reject vague advice that never becomes a ${specialist.title} deliverable.`,
    "Reject fake confidence built on unverified inputs.",
    "Reject bloated scope that tries to solve the whole vertical in one pass.",
    "Reject named-expert cosplay; use experts as lenses, not as masks.",
  ];
}

function buildDepartmentSpecialists(department) {
  return department.subAgents.map((specialistId) => {
    const specialist = specialistTemplatesByDepartment[department.id]?.find(
      (item) => item.id === specialistId
    );
    if (!specialist) {
      throw new Error(`Missing specialist template for ${department.id}/${specialistId}`);
    }
    return specialist;
  });
}

function renderDepartmentAgent(agent) {
  const { industry, department } = agent;
  const expertLenses = buildExpertLenses(industry, department);
  const mentalModels = buildMentalModels(industry, department);
  const toolTargets = buildToolTargets(industry, department);
  const expectedInputs = buildExpectedInputs(industry, department);
  const deliverables = buildDeliverables(industry, department);
  const guardrails = buildGuardrails(industry);
  const specialists = buildDepartmentSpecialists(department);
  const downstreamDepartments = departmentOrchestration[department.id] ?? [];
  const title = `${industry.name} ${department.title}`;

  return `# ${title}

> Generated by Meta_Kim Agent Foundry as a department-level agent blueprint.

## Identity

- **Department Agent ID:** \`${agent.id}\`
- **Industry:** ${industry.name}
- **Department:** ${department.title}
- **Mission:** ${buildMission(industry, department)}

## Department Charter

${toBullets([
  `Industry thesis: ${industry.thesis}.`,
  `Department mission: ${department.mission}.`,
  "This blueprint is designed as one department-level agent, not the final specialist swarm.",
  "Its next expansion step is to split into ten subordinate specialist agents.",
])}

## Reference Thinkers

${toBullets(expertLenses)}

## Core Mental Models

${toBullets(mentalModels)}

## Tool Targets

${toBullets(toolTargets)}

## Expected Inputs

${toBullets(expectedInputs)}

## Expected Deliverables

${toBullets(deliverables)}

## Planned Sub-Agent Slots

${toBullets(specialists.map((specialist) => `${specialist.title} (\`${specialist.id}\`)`))}

## Department Handoffs

${toBullets(
  downstreamDepartments.map(
    (departmentId) =>
      `${department.title} commonly hands work to \`${departmentId}\` during multi-department orchestration.`
  )
)}

## Guardrails

${toBullets(guardrails)}

## Scaling Note

- Meta_Kim treats this file as a **department seed**.
- One department seed expands into **10 specialist agents** in the next stage.
- Across the full matrix, **20 industries x 5 departments x 10 specialists = 1000 agents**.
- Use \`meta-warden\` and \`meta-conductor\` to orchestrate cross-department collaboration.
- Use \`meta-genesis\` to turn this department brief into runtime personas.
- Use \`meta-artisan\` to finalize tools, MCP, and skill fit.
`;
}

function renderSpecialistBrief(agent, specialist) {
  const { industry, department } = agent;
  const expertLenses = buildExpertLenses(industry, department, specialist);
  const mentalModels = buildMentalModels(industry, department, specialist);
  const toolTargets = buildToolTargets(industry, department, specialist);
  const expectedInputs = dedupe([...industry.inputs, ...department.inputs]);
  const deliverables = dedupe([...specialist.outputs, ...department.outputs]);
  const guardrails = buildGuardrails(industry);
  const specialistId = `${agent.id}-${specialist.id}`;
  const owns = buildSpecialistOwns(agent, specialist, deliverables);
  const refuses = buildSpecialistRefuses(agent, specialist);
  const activationSignals = buildSpecialistActivationSignals(agent, specialist, expectedInputs, deliverables);
  const decisionRules = buildSpecialistDecisionRules(agent, specialist, expectedInputs, deliverables);
  const qualityBar = buildSpecialistQualityBar(specialist, deliverables);
  const handoffRules = buildSpecialistHandoffRules(agent, specialist);
  const antiSlop = buildSpecialistAntiSlop(specialist);

  return `# ${industry.name} ${department.title} / ${specialist.title}

> Generated by Meta_Kim Agent Foundry as a specialist-level agent brief.

## Identity

- **Specialist Agent ID:** \`${specialistId}\`
- **Parent Department Agent:** \`${agent.id}\`
- **Industry:** ${industry.name}
- **Department:** ${department.title}
- **Specialist Role:** ${specialist.title}
- **Mandate:** ${specialist.mandate}

## Why This Specialist Exists

${toBullets([
  `Parent department mission: ${department.mission}.`,
  `Specialist mandate: ${specialist.mandate}`,
  "This specialist exists to own one narrow, repeatable slice of work inside the department.",
])}

## Owns

${toBullets(owns)}

## Refuses

${toBullets(refuses)}

## Activate When

${toBullets(activationSignals)}

## Reference Thinkers

${toBullets(expertLenses)}

## Core Mental Models

${toBullets(mentalModels)}

## Tool Targets

${toBullets(toolTargets)}

## Expected Inputs

${toBullets(expectedInputs)}

## Expected Deliverables

${toBullets(deliverables)}

## Decision Rules

${toBullets(decisionRules)}

## Upstream and Downstream

${toBullets([
  `Upstream: ${department.title} and any departments routed in by meta-conductor.`,
  `Downstream: returns specialist-grade signal back to ${department.title}.`,
  "Escalate cross-department conflicts to meta-warden instead of solving them silently.",
])}

## Quality Bar

${toBullets(qualityBar)}

## Handoff Rules

${toBullets(handoffRules)}

## Anti-Slop Checks

${toBullets(antiSlop)}

## Guardrails

${toBullets(guardrails)}
`;
}

function renderDepartmentIndex(agents) {
  const grouped = industries.map((industry) => {
    const rows = agents.filter((agent) => agent.industry.id === industry.id);
    const bullets = rows
      .map((agent) => `- \`${agent.id}\` -> ${agent.department.title}`)
      .join("\n");
    return `## ${industry.name}\n\n${bullets}`;
  });

  const totalSpecialists = agents.length * 10;

  return `# Meta_Kim Department Agent Foundry

Generated catalog size:

- **100 department agents**
- **1000 specialist agents**

Matrix:

- ${industries.length} industries
- ${departmentTemplates.length} departments
- ${industries.length * departmentTemplates.length} department seeds
- ${totalSpecialists} specialist agents

This directory is generated from:

- \`factory/catalog/foundry-config.mjs\`
- \`scripts/generate-industry-agents.mjs\`

Output layout:

- \`departments/<industry>/<department>.md\`
- \`specialists/<industry>/<department>/<specialist>.md\`
- \`industry-coverage-matrix.md\`
- \`organization-map.json\`
- \`department-call-protocol.json\`
- \`orchestration-playbooks.md\`
- \`flagship-20.md\`
- \`flagship-20/<industry>.md\`

${grouped.join("\n\n")}
`;
}

function renderOrchestrationPlaybooks() {
  return `# Meta_Kim Multi-Department Orchestration Playbooks

These playbooks are the default cross-department routes for \`meta-conductor\` and \`meta-warden\`.

## 1. New Market Entry

1. \`strategy-office\` frames the entry thesis and bet size
2. \`research-intelligence\` validates evidence, policy, and competitor signal
3. \`risk-compliance\` pressure-tests downside and regulatory exposure
4. \`product-delivery\` defines what must exist to enter the market credibly
5. \`growth-operations\` plans demand capture, launch, and operating cadence

## 2. New Product or Service Launch

1. \`strategy-office\` clarifies why this launch matters
2. \`research-intelligence\` validates user and market signal
3. \`product-delivery\` builds the launchable system
4. \`risk-compliance\` gates rollout risk
5. \`growth-operations\` owns launch execution and performance tracking

## 3. Growth Repair

1. \`growth-operations\` isolates funnel and throughput breakdowns
2. \`research-intelligence\` checks whether the signal is real or noisy
3. \`product-delivery\` changes workflow or product friction
4. \`risk-compliance\` checks downside of aggressive fixes
5. \`strategy-office\` decides whether the repair changes the strategic thesis

## 4. Crisis or Incident Response

1. \`risk-compliance\` becomes the lead department
2. \`research-intelligence\` rebuilds the fact base
3. \`product-delivery\` patches the broken system
4. \`strategy-office\` updates executive decision posture
5. \`growth-operations\` manages external-facing operational recovery

## 5. Investment or Capital Allocation

1. \`research-intelligence\` builds the evidence base
2. \`strategy-office\` frames the thesis and portfolio logic
3. \`risk-compliance\` models downside and constraint exposure
4. \`product-delivery\` evaluates execution feasibility if the bet is operational
5. \`growth-operations\` estimates the go-to-market or operating engine after the bet
`;
}

function renderCoverageMatrix(agents) {
  const rows = industries.map((industry) => {
    const departmentRows = agents.filter((agent) => agent.industry.id === industry.id);
    const departmentList = departmentRows
      .map((agent) => `${agent.department.title} (\`${agent.id}\`)`)
      .join("<br/>");
    const flagship = flagshipSelectionByIndustry[industry.id];
    const flagshipAgent = departmentRows.find((agent) => agent.department.id === flagship.department);
    return `| ${industry.name} | ${departmentRows.length} | ${departmentRows.length * 10} | ${departmentList} | \`${flagshipAgent.id}\` |`;
  });

  return `# Meta_Kim Industry Coverage Matrix

This file answers the simple question directly:

- **What industries are covered?**
- **Which departments exist inside each industry?**
- **How many specialist slots does each industry have?**
- **Which agent is chosen as the first flagship in that industry?**

## Summary

- Industries: ${industries.length}
- Departments per industry: ${departmentTemplates.length}
- Department agents: ${agents.length}
- Specialist agents: ${agents.length * 10}

## Coverage Table

| Industry | Department Seeds | Specialist Slots | Departments | First Flagship |
| --- | ---: | ---: | --- | --- |
${rows.join("\n")}
`;
}

function buildFlagshipList(agents) {
  return industries.map((industry) => {
    const selection = flagshipSelectionByIndustry[industry.id];
    if (!selection) {
      throw new Error(`Missing flagship selection for industry ${industry.id}`);
    }
    const agent = agents.find(
      (item) => item.industry.id === industry.id && item.department.id === selection.department
    );
    if (!agent) {
      throw new Error(`Missing flagship agent for ${industry.id}/${selection.department}`);
    }
    return {
      industry,
      department: agent.department,
      agent,
      reason: selection.reason,
      specialists: buildDepartmentSpecialists(agent.department),
    };
  });
}

function renderFlagshipIndex(flagships) {
  const rows = flagships.map(
    (item) =>
      `| ${item.industry.name} | ${item.department.title} | \`${item.agent.id}\` | ${item.reason} |`
  );

  return `# Meta_Kim Flagship 20

These are the **first 20 flagship agents** selected from the 100 department seeds.

Selection rule:

- exactly **1 flagship department agent per industry**
- chosen as the best first operating point for that industry's future department system
- intended for earlier manual refinement before wider specialist polishing

## Why This Layer Exists

The full foundry already covers **100 department seeds + 1000 specialists**.

But not every team wants to start by polishing 1100 assets at once.

So this layer answers a more practical question:

**If you only refine the first wave now, which 20 should you start with?**

## Flagship Table

| Industry | Flagship Department | Agent ID | Why It Goes First |
| --- | --- | --- | --- |
${rows.join("\n")}
`;
}

function renderFlagshipBrief(flagship) {
  const { industry, department, agent, reason, specialists } = flagship;
  const downstreamDepartments = departmentOrchestration[department.id] ?? [];

  return `# ${industry.name} Flagship Agent

## Flagship Pick

- **Industry:** ${industry.name}
- **Flagship Department:** ${department.title}
- **Agent ID:** \`${agent.id}\`
- **Why first:** ${reason}

## What This Flagship Owns

- It is the first high-priority department seed to polish in the ${industry.name} vertical.
- It should become the operating hub for the first manual refinement wave.
- It should route later work into sibling departments instead of trying to swallow the whole vertical.

## First-Wave Specialist Ladder

${toBullets(specialists.map((specialist) => `${specialist.title} (\`${specialist.id}\`)`))}

## First-Wave Expert Lenses

${toBullets(buildExpertLenses(industry, department))}

## First-Wave Tool Targets

${toBullets(buildToolTargets(industry, department))}

## Suggested Sibling Department Routes

${toBullets(downstreamDepartments.map((item) => `\`${item}\``))}

## Runtime Pack Paths

- Claude Code: \`factory/runtime-packs/claude/agents/${agent.id}.md\`
- Codex: \`factory/runtime-packs/codex/agents/${agent.id}.toml\`
- OpenClaw: \`factory/runtime-packs/openclaw/workspaces/${agent.id}/\`

## Refinement Goal

- Turn this department seed into a manually polished flagship before scaling refinement to its 10 specialists.
- Keep \`meta-warden\` as arbitration owner and \`meta-conductor\` as orchestration owner.
`;
}

function buildDepartmentCallProtocol() {
  return {
    version: 1,
    orchestrator: "meta-conductor",
    arbiter: "meta-warden",
    defaults: {
      escalateCrossDepartmentConflictsTo: "meta-warden",
      useDepartmentSeedBeforeSpecialist: true,
      specialistEscalationReturnsToParentDepartment: true,
    },
    departmentHandoffs: departmentOrchestration,
    playbooks: [
      {
        id: "new-market-entry",
        stages: [
          "strategy-office",
          "research-intelligence",
          "risk-compliance",
          "product-delivery",
          "growth-operations",
        ],
      },
      {
        id: "new-product-launch",
        stages: [
          "strategy-office",
          "research-intelligence",
          "product-delivery",
          "risk-compliance",
          "growth-operations",
        ],
      },
      {
        id: "growth-repair",
        stages: [
          "growth-operations",
          "research-intelligence",
          "product-delivery",
          "risk-compliance",
          "strategy-office",
        ],
      },
      {
        id: "crisis-response",
        stages: [
          "risk-compliance",
          "research-intelligence",
          "product-delivery",
          "strategy-office",
          "growth-operations",
        ],
      },
      {
        id: "capital-allocation",
        stages: [
          "research-intelligence",
          "strategy-office",
          "risk-compliance",
          "product-delivery",
          "growth-operations",
        ],
      },
    ],
  };
}

function buildOrganizationMap(agents) {
  const specialistAgents = [];
  for (const agent of agents) {
    for (const specialist of buildDepartmentSpecialists(agent.department)) {
      specialistAgents.push({
        id: `${agent.id}-${specialist.id}`,
        parentDepartmentAgent: agent.id,
        industry: agent.industry.id,
        department: agent.department.id,
        specialist: specialist.id,
        title: `${agent.industry.name} ${agent.department.title} / ${specialist.title}`,
      });
    }
  }

  return {
    summary: {
      industries: industries.length,
      departments: departmentTemplates.length,
      departmentSeeds: agents.length,
      specialistAgents: specialistAgents.length,
      totalAgents: agents.length + specialistAgents.length,
    },
    orchestration: departmentOrchestration,
    departments: agents.map((agent) => ({
      id: agent.id,
      industry: agent.industry.id,
      department: agent.department.id,
      title: `${agent.industry.name} ${agent.department.title}`,
      specialists: buildDepartmentSpecialists(agent.department).map((specialist) => ({
        id: `${agent.id}-${specialist.id}`,
        specialist: specialist.id,
        title: specialist.title,
      })),
    })),
    specialists: specialistAgents,
  };
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readTextFileWithRetry(filePath, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") throw error;
      const retryable = ["EPERM", "EBUSY", "EACCES"].includes(error.code);
      if (!retryable || attempt === attempts) throw error;
      await sleep(60 * attempt);
    }
  }
  return null;
}

async function readFileIfExists(filePath) {
  try {
    return await readTextFileWithRetry(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeFile(filePath, nextContent, changedFiles) {
  const current = await readFileIfExists(filePath);
  if (current === nextContent) return;
  if (checkOnly) {
    changedFiles.push(path.relative(repoRoot, filePath).replace(/\\/g, "/"));
    return;
  }
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, nextContent, "utf8");
  changedFiles.push(path.relative(repoRoot, filePath).replace(/\\/g, "/"));
}

async function listFilesRecursive(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(fullPath)));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  const changedFiles = [];
  const departmentAgents = buildDepartmentMatrix();
  const organizationMap = buildOrganizationMap(departmentAgents);
  const callProtocol = buildDepartmentCallProtocol();
  const flagships = buildFlagshipList(departmentAgents);

  if (!checkOnly) {
    await fs.rm(outDir, { recursive: true, force: true });
  }

  await ensureDir(outDir);
  await writeFile(path.join(outDir, "README.md"), renderDepartmentIndex(departmentAgents), changedFiles);
  await writeFile(
    path.join(outDir, "industry-coverage-matrix.md"),
    renderCoverageMatrix(departmentAgents),
    changedFiles
  );
  await writeFile(
    path.join(outDir, "organization-map.json"),
    `${JSON.stringify(organizationMap, null, 2)}\n`,
    changedFiles
  );
  await writeFile(
    path.join(outDir, "department-call-protocol.json"),
    `${JSON.stringify(callProtocol, null, 2)}\n`,
    changedFiles
  );
  await writeFile(
    path.join(outDir, "agent-index.json"),
    `${JSON.stringify(
      organizationMap.departments.map((department) => ({
        id: department.id,
        industry: department.industry,
        department: department.department,
        title: department.title,
        specialists: department.specialists,
      })),
      null,
      2
    )}\n`,
    changedFiles
  );
  await writeFile(
    path.join(outDir, "orchestration-playbooks.md"),
    renderOrchestrationPlaybooks(),
    changedFiles
  );
  await writeFile(
    path.join(outDir, "flagship-20.md"),
    renderFlagshipIndex(flagships),
    changedFiles
  );
  await writeFile(
    path.join(outDir, "flagship-20.json"),
    `${JSON.stringify(
      flagships.map((item) => ({
        industry: item.industry.id,
        department: item.department.id,
        agentId: item.agent.id,
        reason: item.reason,
        specialists: item.specialists.map((specialist) => specialist.id),
      })),
      null,
      2
    )}\n`,
    changedFiles
  );

  for (const agent of departmentAgents) {
    await writeFile(
      path.join(outDir, "departments", agent.industry.id, `${agent.department.id}.md`),
      renderDepartmentAgent(agent),
      changedFiles
    );

    for (const specialist of buildDepartmentSpecialists(agent.department)) {
      await writeFile(
        path.join(
          outDir,
          "specialists",
          agent.industry.id,
          agent.department.id,
          `${specialist.id}.md`
        ),
        renderSpecialistBrief(agent, specialist),
        changedFiles
      );
    }
  }

  for (const flagship of flagships) {
    await writeFile(
      path.join(outDir, "flagship-20", `${flagship.industry.id}.md`),
      renderFlagshipBrief(flagship),
      changedFiles
    );
  }

  if (checkOnly) {
    const expected = new Set([
      path.join(outDir, "README.md"),
      path.join(outDir, "industry-coverage-matrix.md"),
      path.join(outDir, "organization-map.json"),
      path.join(outDir, "department-call-protocol.json"),
      path.join(outDir, "agent-index.json"),
      path.join(outDir, "orchestration-playbooks.md"),
      path.join(outDir, "flagship-20.md"),
      path.join(outDir, "flagship-20.json"),
      ...flagships.map((flagship) => path.join(outDir, "flagship-20", `${flagship.industry.id}.md`)),
      ...departmentAgents.map((agent) =>
        path.join(outDir, "departments", agent.industry.id, `${agent.department.id}.md`)
      ),
      ...departmentAgents.flatMap((agent) =>
        buildDepartmentSpecialists(agent.department).map((specialist) =>
          path.join(
            outDir,
            "specialists",
            agent.industry.id,
            agent.department.id,
            `${specialist.id}.md`
          )
        )
      ),
    ]);
    const existing = new Set((await listFilesRecursive(outDir)).map((file) => path.normalize(file)));

    for (const file of existing) {
      if (!expected.has(file)) {
        changedFiles.push(path.relative(repoRoot, file).replace(/\\/g, "/"));
      }
    }

    if (changedFiles.length > 0) {
      console.error("Industry foundry assets are out of sync:");
      for (const file of changedFiles.sort()) {
        console.error(` - ${file}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log("Industry foundry assets are in sync.");
    return;
  }

  console.log(
    `Generated ${departmentAgents.length} department agents and ${organizationMap.specialists.length} specialist agents.`
  );
  console.log(`Artifacts written to ${path.relative(repoRoot, outDir).replace(/\\/g, "/")}`);
  console.log(
    `Summary: ${organizationMap.summary.industries} industries, ${organizationMap.summary.departmentSeeds} departments, ${organizationMap.summary.specialistAgents} specialists.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
