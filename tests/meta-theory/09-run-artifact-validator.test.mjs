import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import path from "node:path";
import { REPO_ROOT } from "./_helpers.mjs";

const execFileAsync = promisify(execFile);

describe("validate-run-artifact.mjs", () => {
  const validFixture = path.join(REPO_ROOT, "tests", "fixtures", "run-artifacts", "valid-run.json");
  const invalidFixture = path.join(REPO_ROOT, "tests", "fixtures", "run-artifacts", "invalid-run-public-ready.json");
  const invalidCompactionFixture = path.join(
    REPO_ROOT,
    "tests",
    "fixtures",
    "run-artifacts",
    "invalid-run-compaction-open-findings.json"
  );

  async function validateFixture(fixturePath) {
    const { stdout } = await execFileAsync(
      "node",
      ["scripts/validate-run-artifact.mjs", fixturePath],
      { cwd: REPO_ROOT }
    );
    return JSON.parse(stdout);
  }

  async function writeTempFixture(mutate) {
    const raw = await fs.readFile(validFixture, "utf8");
    const artifact = JSON.parse(raw);
    mutate(artifact);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-validate-"));
    const file = path.join(dir, "fixture.json");
    await fs.writeFile(file, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    return file;
  }

  test("accepts a valid run artifact with full finding lineage", async () => {
    const result = await validateFixture(validFixture);
    assert.equal(result.ok, true);
    assert.ok(result.validatedPackets.includes("fetchPacket"));
    assert.ok(result.validatedPackets.includes("dispatchEnvelopePacket"));
    assert.ok(result.validatedPackets.includes("orchestrationTaskBoardPacket"));
    assert.ok(result.validatedPackets.includes("cardPlanPacket"));
    assert.ok(result.validatedPackets.includes("summaryPacket"));
  });

  test("rejects an invalid public-ready run artifact", async () => {
    await assert.rejects(
      execFileAsync("node", ["scripts/validate-run-artifact.mjs", invalidFixture], {
        cwd: REPO_ROOT,
      })
    );
  });

  test("rejects compaction packets that drop open findings", async () => {
    await assert.rejects(
      execFileAsync("node", ["scripts/validate-run-artifact.mjs", invalidCompactionFixture], {
        cwd: REPO_ROOT,
      })
    );
  });

  test("rejects dispatch envelopes without ownerAgent", async () => {
    const tempFixture = await writeTempFixture((artifact) => {
      artifact.dispatchEnvelopePacket.ownerAgent = "";
    });
    await assert.rejects(
      execFileAsync("node", ["scripts/validate-run-artifact.mjs", tempFixture], { cwd: REPO_ROOT })
    );
  });

  test("rejects dispatch envelopes with overlapping allowed/blocked capabilities", async () => {
    const tempFixture = await writeTempFixture((artifact) => {
      artifact.dispatchEnvelopePacket.blockedCapabilities = [
        ...artifact.dispatchEnvelopePacket.blockedCapabilities,
        artifact.dispatchEnvelopePacket.allowedCapabilities[0],
      ];
    });
    await assert.rejects(
      execFileAsync("node", ["scripts/validate-run-artifact.mjs", tempFixture], { cwd: REPO_ROOT })
    );
  });

  test("rejects dispatch envelopes with illegal memoryMode", async () => {
    const tempFixture = await writeTempFixture((artifact) => {
      artifact.dispatchEnvelopePacket.memoryMode = "inherit_random_context";
    });
    await assert.rejects(
      execFileAsync("node", ["scripts/validate-run-artifact.mjs", tempFixture], { cwd: REPO_ROOT })
    );
  });

  test("rejects missing fetchPacket for governed runs", async () => {
    const tempFixture = await writeTempFixture((artifact) => {
      delete artifact.fetchPacket;
    });
    await assert.rejects(
      execFileAsync("node", ["scripts/validate-run-artifact.mjs", tempFixture], {
        cwd: REPO_ROOT,
      })
    );
  });

  test("rejects current-project fetch packets that check other projects", async () => {
    const tempFixture = await writeTempFixture((artifact) => {
      artifact.fetchPacket.projectsChecked = [
        ...artifact.fetchPacket.projectsChecked,
        {
          projectRef: "project-other",
          checkMode: "global_registry_hit",
          reason: "unexpected cross-project fetch",
        },
      ];
    });
    await assert.rejects(
      execFileAsync("node", ["scripts/validate-run-artifact.mjs", tempFixture], {
        cwd: REPO_ROOT,
      })
    );
  });

  test("rejects review findings that do not name a source project", async () => {
    const tempFixture = await writeTempFixture((artifact) => {
      delete artifact.reviewPacket.findings[0].sourceProject;
    });
    await assert.rejects(
      execFileAsync("node", ["scripts/validate-run-artifact.mjs", tempFixture], {
        cwd: REPO_ROOT,
      })
    );
  });

  test("rejects dispatch envelopes missing reviewOwner", async () => {
    const tempFixture = await writeTempFixture((artifact) => {
      artifact.dispatchEnvelopePacket.reviewOwner = "";
    });
    await assert.rejects(
      execFileAsync("node", ["scripts/validate-run-artifact.mjs", tempFixture], { cwd: REPO_ROOT })
    );
  });

  test("rejects dispatch envelopes missing verificationOwner", async () => {
    const tempFixture = await writeTempFixture((artifact) => {
      artifact.dispatchEnvelopePacket.verificationOwner = "";
    });
    await assert.rejects(
      execFileAsync("node", ["scripts/validate-run-artifact.mjs", tempFixture], { cwd: REPO_ROOT })
    );
  });

  test("rejects missing orchestration task board for non-query flows", async () => {
    const tempFixture = await writeTempFixture((artifact) => {
      delete artifact.orchestrationTaskBoardPacket;
    });
    await assert.rejects(
      execFileAsync("node", ["scripts/validate-run-artifact.mjs", tempFixture], {
        cwd: REPO_ROOT,
      })
    );
  });

  test("rejects missing capability gap packet when owner creation is required", async () => {
    const tempFixture = await writeTempFixture((artifact) => {
      artifact.taskClassification.upgradeReasons = [
        ...artifact.taskClassification.upgradeReasons,
        "owner_creation_required",
      ];
      delete artifact.capabilityGapPacket;
    });
    await assert.rejects(
      execFileAsync("node", ["scripts/validate-run-artifact.mjs", tempFixture], {
        cwd: REPO_ROOT,
      })
    );
  });

  test("rejects execution agent card gaps when factory action is create_execution_agent", async () => {
    const tempFixture = await writeTempFixture((artifact) => {
      artifact.taskClassification.upgradeReasons = [
        ...artifact.taskClassification.upgradeReasons,
        "owner_creation_required",
      ];
      artifact.capabilityGapPacket = {
        gapId: "gap-001",
        requestedCapability: "topic-analysis",
        currentAgentsChecked: ["meta-prism", "meta-artisan"],
        insufficiencyReason: "No execution agent currently owns this business capability.",
        resolutionAction: "create_execution_agent",
        requestedBy: "meta-conductor",
        approvedBy: "meta-warden",
      };
      artifact.executionAgentCard = {
        agentId: "topic-analyst",
        purpose: "Owns topic analysis execution for growth workflows.",
        capabilities: ["topic-clustering", "trend-prioritization"],
        nonCapabilities: ["article-writing"],
        dependencies: ["findskill:topic-analysis"],
        inputs: ["growth goal", "candidate topics"],
        outputs: [],
      };
    });
    await assert.rejects(
      execFileAsync("node", ["scripts/validate-run-artifact.mjs", tempFixture], {
        cwd: REPO_ROOT,
      })
    );
  });
});
