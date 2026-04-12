#!/usr/bin/env node
/**
 * Reads a governed run artifact JSON and prints what must happen in the next loop iteration
 * (open findings, verification gaps, public-display blockers). Use after a partial run or failed validate:run.
 *
 * Usage: node scripts/prompt-next-iteration.mjs <artifact.json>
 *    or: npm run prompt:next-iteration -- path/to/run.json
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  const artifactPath = process.argv[2];
  if (!artifactPath) {
    fail("Usage: node scripts/prompt-next-iteration.mjs <artifact.json>");
  }

  const resolved = path.resolve(process.cwd(), artifactPath);
  let artifact;
  try {
    artifact = JSON.parse(await fs.readFile(resolved, "utf8"));
  } catch (e) {
    fail(`Cannot read or parse JSON: ${resolved}\n${e.message}`);
  }

  const lines = [];
  let actionItems = 0;
  const flow = artifact.taskClassification?.governanceFlow;
  if (flow) {
    lines.push(`governanceFlow: ${flow}`);
  }
  if (!artifact.fetchPacket) {
    lines.push(
      "- [ ] Add fetchPacket (projectsChecked, projectLocalSources, globalRegistryHits, capabilityMatches, capabilityGaps, graphSources, knowledgeSources)."
    );
    actionItems += 1;
  }

  if (!artifact.intentPacket && (flow === "complex_dev" || flow === "meta_analysis")) {
    lines.push(
      "- [ ] Add intentPacket (trueUserIntent, successCriteria, nonGoals, intentPacketVersion: v1) — required for this governance flow."
    );
    actionItems += 1;
  }

  if (!artifact.intentGatePacket && (flow === "complex_dev" || flow === "meta_analysis")) {
    lines.push(
      "- [ ] Add intentGatePacket (ambiguitiesResolved, requiresUserChoice, defaultAssumptions[], intentGatePacketVersion: v1; if requiresUserChoice=true add pendingUserChoices[])."
    );
    actionItems += 1;
  }

  const findings = artifact.reviewPacket?.findings;
  const closedByVerify = new Set();
  for (const r of artifact.verificationPacket?.verificationResults ?? []) {
    if (r && ["verified_closed", "accepted_risk"].includes(r.closeState)) {
      closedByVerify.add(r.findingId);
    }
  }
  if (Array.isArray(findings)) {
    const open = findings.filter(
      (f) => f && ["open", "fixed_pending_verify"].includes(f.closeState) && !closedByVerify.has(f.findingId)
    );
    if (open.length) {
      actionItems += open.length;
      lines.push(`Open or pending-verify findings (${open.length}):`);
      for (const f of open) {
        lines.push(`  - ${f.findingId}: ${f.summary || f.requiredAction || "(no summary)"}`);
      }
    }
  }

  const vp = artifact.verificationPacket;
  if (vp && vp.verified !== true) {
    actionItems += 1;
    lines.push("- [ ] verificationPacket.verified is not true — finish revisionResponses / verificationResults / closeFindings.");
    if (Array.isArray(vp.remainingIssues) && vp.remainingIssues.length) {
      lines.push(`  remainingIssues: ${vp.remainingIssues.join("; ")}`);
    }
  }

  const sp = artifact.summaryPacket;
  if (sp) {
    const need = [
      "verifyPassed",
      "summaryClosed",
      "singleDeliverableMaintained",
      "deliverableChainClosed",
      "consolidatedDeliverablePresent",
    ];
    const falseFields = need.filter((k) => sp[k] !== true);
    if (sp.publicReady === true && falseFields.length) {
      actionItems += 1;
      lines.push(
        `- [ ] summaryPacket.publicReady is true but these flags are not all true: ${falseFields.join(", ")}`
      );
    }
    if (sp.publicReady !== true && Array.isArray(sp.blockedBy)) {
      lines.push(`publicReady=false; blockedBy: ${sp.blockedBy.length ? sp.blockedBy.join("; ") : "(empty — add reasons)"}`);
    }
  } else {
    actionItems += 1;
    lines.push("- [ ] Missing summaryPacket.");
  }

  lines.push("");
  lines.push("Suggested next prompt (paste into the orchestrator):");
  if (actionItems > 0) {
    lines.push(
      "Continue the governed run: address the items above, update the run artifact JSON, then run npm run validate:run -- <artifact.json>."
    );
  } else {
    lines.push(
      "No open findings or obvious packet gaps were detected from this artifact snapshot. If npm run validate:run still fails, use the validator error message as the source of truth."
    );
  }

  lines.push("");
  lines.push("Minimal context reload (after API error, compaction, or new session):");
  lines.push(
    "  Reload into context: runHeader, taskClassification, fetchPacket, intentPacket, intentGatePacket (if complex_dev/meta_analysis), cardPlanPacket, dispatchEnvelopePacket, orchestrationTaskBoardPacket, capabilityGapPacket / executionAgentCard (when applicable), dispatchBoard,"
  );
  lines.push(
    "  workerTaskPackets, workerResultPackets, reviewPacket, verificationPacket, summaryPacket, evolutionWritebackPacket — then npm run validate:run -- <artifact.json>."
  );

  console.log(lines.join("\n"));
}

main();
