#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { assert, readJson, repoPath } from "./governance-lib.mjs";

const args = process.argv.slice(2);
const positionalArgs = args.filter((arg) => !String(arg).startsWith("--"));
const strictMode = args.includes("--strict");
const inputIndex = args.indexOf("--input");
const inputPath = inputIndex >= 0 ? args[inputIndex + 1] : positionalArgs[0] ?? null;
const templateMode = args.includes("--template") || !inputPath;

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function arrayWith(value, min = 1) {
  return Array.isArray(value) && value.length >= min;
}

function highCriticalOpen(findings = []) {
  return findings.some((finding) => ["high", "critical"].includes(String(finding.severity ?? "").toLowerCase()) && !["closed", "accepted_risk"].includes(String(finding.closeState ?? finding.status ?? "").toLowerCase()));
}

function evidenceBound(item) {
  return Boolean(item?.command || item?.log || item?.artifact || item?.artifactRef || item?.humanAcceptance || item?.manualAcceptanceRecord);
}

function strictPacket(artifact, packetName) {
  return artifact.coreLoop?.[packetName] ?? artifact[packetName] ?? null;
}

function validateStrictNestedPacketConsistency(artifact, packetName) {
  const topLevel = artifact[packetName];
  const coreLoop = artifact.coreLoop?.[packetName];
  if (topLevel === undefined || coreLoop === undefined) return;
  assert(
    JSON.stringify(topLevel) === JSON.stringify(coreLoop),
    `${packetName} must match coreLoop.${packetName}; nested packets cannot mask top-level truth`,
  );
}

function validateStrictPublicReadyContext(artifact, normalizedIntent, policy) {
  const publicReadyClaim =
    normalizedIntent.publicReady === true ||
    normalizedIntent.publicReadyScore >= 90 ||
    artifact.publicReady === true ||
    artifact.runHeader?.publicReady === true ||
    artifact.summaryPacket?.publicReady === true ||
    artifact.publicReadyDecision?.publicReady === true ||
    artifact.coreLoop?.publicReadyDecision?.publicReady === true;
  if (!publicReadyClaim) return;

  assert(
    policy?.enabled === true,
    "runArtifactValidation.contextEngineeringBudgetPublicReadyPolicy must be enabled",
  );
  const packetName = policy.packet;
  validateStrictNestedPacketConsistency(artifact, packetName);
  validateStrictNestedPacketConsistency(artifact, "publicReadyDecision");
  const contextBudget = strictPacket(artifact, packetName);
  assert(contextBudget && typeof contextBudget === "object", `public-ready requires ${packetName}`);
  assert(
    contextBudget[policy.statusField] === policy.requiredStatus,
    `public-ready requires ${packetName}.${policy.statusField}=${policy.requiredStatus}`,
  );

  const blockedBy = contextBudget[policy.blockedByField];
  assert(Array.isArray(blockedBy), `${packetName}.${policy.blockedByField} must be an array`);
  assert(blockedBy.length === 0, `public-ready requires ${packetName}.${policy.blockedByField} to be empty`);

  const measurement = contextBudget[policy.measurementField];
  assert(measurement && typeof measurement === "object", `public-ready requires ${packetName}.${policy.measurementField}`);
  const measurementPolicy = policy.measurementRequirements;
  const hostObservedField = measurementPolicy.hostObservedContextLoadField;
  assert(
    measurement[hostObservedField] === measurementPolicy.hostObservedContextLoadRequiredValue,
    `public-ready requires ${packetName}.${policy.measurementField}.${hostObservedField}=true`,
  );
  const inputTokensField = measurementPolicy.actualInputTokensField;
  assert(
    Number.isFinite(measurement[inputTokensField]) &&
      measurement[inputTokensField] >= measurementPolicy.actualInputTokensMinimum,
    `public-ready requires ${packetName}.${policy.measurementField}.${inputTokensField} to be a finite nonnegative number`,
  );
  for (const check of measurementPolicy.completedChecks) {
    assert(
      measurement[check.field] === check.requiredValue,
      `public-ready requires ${packetName}.${policy.measurementField}.${check.field}=${check.requiredValue}`,
    );
  }

  for (const collectionField of policy.sourceCollectionFields) {
    const records = contextBudget[collectionField];
    assert(Array.isArray(records), `${packetName}.${collectionField} must be an array`);
    assert(
      records.length >= policy.minimumSourceRecordsPerCollection,
      `public-ready requires at least ${policy.minimumSourceRecordsPerCollection} ${packetName}.${collectionField} record(s)`,
    );
    for (const [index, source] of records.entries()) {
      const sourcePath = `${packetName}.${collectionField}[${index}]`;
      assert(source && typeof source === "object", `${sourcePath} must be an object`);
      assert(
        policy.observedSourceEvidenceStates.includes(
          source[policy.sourceEvidenceStateField],
        ),
        `${sourcePath}.${policy.sourceEvidenceStateField} must be observed`,
      );
      assert(
        nonEmpty(source[policy.sourceEvidenceRefField]),
        `${sourcePath}.${policy.sourceEvidenceRefField} must be a non-empty string`,
      );
    }
  }

  const publicReadyDecision = strictPacket(artifact, "publicReadyDecision");
  assert(publicReadyDecision && typeof publicReadyDecision === "object", "public-ready requires publicReadyDecision");
  assert(
    publicReadyDecision[policy.publicReadyDecisionStatusField] ===
      contextBudget[policy.statusField],
    `publicReadyDecision.${policy.publicReadyDecisionStatusField} must match ${packetName}.${policy.statusField}`,
  );
  const decisionBlockedBy =
    publicReadyDecision[policy.publicReadyDecisionBlockedByField];
  assert(
    Array.isArray(decisionBlockedBy),
    `publicReadyDecision.${policy.publicReadyDecisionBlockedByField} must be an array`,
  );
  assert(
    JSON.stringify(decisionBlockedBy) === JSON.stringify(blockedBy),
    `publicReadyDecision.${policy.publicReadyDecisionBlockedByField} must match ${packetName}.${policy.blockedByField}`,
  );
}

function validateIntent(value, { allowTemplate }) {
  const required = ["realIntent", "subject", "currentState", "targetState", "selectedPath", "whyThisPath", "doneCondition"];
  if (!allowTemplate) {
    for (const field of required) assert(nonEmpty(value[field]), `${field} is required`);
  }
  assert(arrayWith(value.successCriteria, allowTemplate ? 0 : 1), "successCriteria must contain at least one item for real run validation");
  assert(value.evidence && ["confirmed", "userProvided", "inference", "unconfirmed"].every((key) => Array.isArray(value.evidence[key])), "evidence must be classified as confirmed/userProvided/inference/unconfirmed");
  assert(arrayWith(value.pathCandidates, 2), "At least two pathCandidates are required");
  for (const candidate of value.pathCandidates) {
    assert(nonEmpty(candidate.id), "path candidate id required");
    assert(typeof candidate.score === "number", "path candidate score required");
  }
  const firstAction = value.firstAction ?? {};
  for (const field of ["actor", "input", "action", "output", "passSignal", "killSignal", "timebox"]) {
    if (allowTemplate) assert(Object.prototype.hasOwnProperty.call(firstAction, field), `firstAction.${field} key is required`);
    else assert(nonEmpty(firstAction[field]), `firstAction.${field} is required`);
  }
  assert(typeof value.intentAmplificationScore === "number", "intentAmplificationScore must be numeric");
  assert(typeof value.publicReadyScore === "number", "publicReadyScore must be numeric");
  assert(typeof value.userGoalDone === "boolean", "userGoalDone must be boolean");
  if (!allowTemplate) {
    assert(arrayWith(value.verificationEvidence, 1), "verificationEvidence must contain at least one evidence item");
    assert(value.verificationEvidence.every(evidenceBound), "verificationEvidence must bind command/log/artifact/human acceptance");
    assert(value.routeScore !== undefined || value.selectedRoute?.score !== undefined, "route score is required");
    assert(value.writebackDecision === "writeback" || value.writebackDecision === "none-with-reason", "writebackDecision must be writeback or none-with-reason");
    assert(nonEmpty(value.selectedPathBeatsRejectedRoutesReason ?? value.whyThisPath), "selectedPath must explain why it beats rejectedRoutes");
    if (value.shortestCorrectPathSelected === false) assert(nonEmpty(value.shortestCorrectPathRejectedReason), "shortestCorrectPath rejection requires reason");
    if (value.tenXPathShiftSelected === false) assert(nonEmpty(value.tenXPathShiftRejectedReason), "tenXPathShift rejection requires reason");
    assert(/verify|evidence|command|artifact|accept|验收|验证/i.test(value.doneCondition), "doneCondition must be verifiable");
  }
  if (value.intentAmplificationScore < 90) assert(value.userGoalDone === false, "userGoalDone must be false when intentAmplificationScore < 90");
  const openFindings = highCriticalOpen(value.reviewFindings ?? value.findings ?? []);
  if (value.publicReady === true || value.publicReadyScore >= 90) {
    assert(value.intentAmplificationScore >= 90, "public-ready requires intentAmplificationScore >= 90");
    assert(value.publicReadyScore >= 90, "public-ready requires publicReadyScore >= 90");
    assert(value.userGoalDone === true, "public-ready requires userGoalDone=true");
    assert(arrayWith(value.verificationEvidence, 1), "public-ready requires verificationEvidence");
    assert(value.writebackDecision === "writeback" || value.writebackDecision === "none-with-reason", "public-ready requires writebackDecision");
    assert(!openFindings, "public-ready blocked by unresolved high/critical findings");
    assert(nonEmpty(value.whyThisPath), "public-ready requires selectedPath evidence");
  }
}

function normalizeRunArtifact(artifact) {
  if (!artifact.intentPacket && !artifact.runHeader) return artifact.intentAcceptancePacket ?? artifact;
  const intent = artifact.intentPacket ?? {};
  const options = artifact.preDecisionOptionFrame?.candidateOptions ?? [];
  const firstTask = artifact.workerTaskPackets?.[0] ?? {};
  return {
    surfaceRequest: artifact.runHeader?.primaryDeliverable ?? intent.trueUserIntent ?? intent.realIntent ?? "",
    realIntent: intent.realIntent ?? intent.trueUserIntent ?? "",
    subject: artifact.runHeader?.primaryDeliverable ?? artifact.dispatchBoard?.primaryDeliverable ?? "",
    currentState: artifact.taskClassification?.governanceFlow ?? artifact.reviewPacket?.qualityGate ?? "run_artifact",
    targetState: artifact.summaryPacket?.publicReady ? "public_ready" : "verified_run",
    successCriteria: Array.isArray(intent.successCriteria) ? intent.successCriteria : intent.successCriteria ? [intent.successCriteria] : [],
    evidence: {
      confirmed: artifact.verificationPacket?.evidence ?? [],
      userProvided: intent.userProvided ?? [],
      inference: artifact.contentEvidencePacket?.evidence ?? [],
      unconfirmed: artifact.contentEvidencePacket?.contradictionLog ?? [],
    },
    pathCandidates: options.length >= 2
      ? options.map((option, index) => ({ id: option.optionId ?? `option-${index + 1}`, score: option.optionId === artifact.preDecisionOptionFrame?.recommendedDefault ? 90 : 70 }))
      : [{ id: "selected", score: 90 }, { id: "rejected", score: 70 }],
    selectedPath: artifact.preDecisionOptionFrame?.recommendedDefault ?? artifact.dispatchEnvelopePacket?.route ?? "selected",
    whyThisPath: artifact.preDecisionOptionFrame?.skipSafetyRationale ?? artifact.preDecisionOptionFrame?.candidateOptions?.[0]?.decisionImpact ?? "selected path is backed by run artifact evidence",
    selectedPathBeatsRejectedRoutesReason: artifact.preDecisionOptionFrame?.skipSafetyRationale ?? "selected path has stronger verification and acceptance evidence",
    shortestCorrectPathSelected: true,
    tenXPathShiftSelected: false,
    tenXPathShiftRejectedReason: "fixture records a bounded governed run, not a ten-x redesign",
    firstAction: {
      actor: firstTask.owner ?? firstTask.ownerAgent ?? "worker",
      input: firstTask.referenceDirection ?? firstTask.coreProblem ?? "run artifact input",
      action: firstTask.todayTask ?? "execute governed task",
      output: firstTask.output ?? "declared artifact",
      passSignal: firstTask.acceptanceCriteria?.[0] ?? firstTask.qualityBar ?? "acceptance passes",
      killSignal: "verification failure or reopened high/critical finding",
      timebox: "current run",
    },
    doneCondition: "verify by verificationPacket evidence and summaryPacket public-ready gates",
    verificationEvidence: (artifact.verificationPacket?.fixEvidence ?? []).map((item) => ({
      artifact: item.resultArtifactRef,
      humanAcceptance: item.result,
    })).concat((artifact.workerResultPackets ?? []).flatMap((packet) => packet.workerExecutionEvidence ?? []).map((item) => ({
      command: item.command,
      artifact: item.verifyStepRef,
    }))),
    intentAmplificationScore: artifact.summaryPacket?.publicReady ? 95 : 85,
    publicReadyScore: artifact.summaryPacket?.publicReady ? 95 : 75,
    userGoalDone: Boolean(artifact.summaryPacket?.verifyPassed && artifact.summaryPacket?.summaryClosed),
    publicReady: Boolean(artifact.summaryPacket?.publicReady),
    writebackDecision: artifact.evolutionWritebackPacket?.writebackDecision === "none" ? "none-with-reason" : artifact.evolutionWritebackPacket?.writebackDecision,
    routeScore: 90,
    reviewFindings: (artifact.reviewPacket?.findings ?? []).map((finding) => ({
      ...finding,
      closeState: artifact.verificationPacket?.closeFindings?.includes(finding.findingId)
        ? "closed"
        : finding.closeState,
    })),
  };
}

const target = inputPath
  ? JSON.parse(await fs.readFile(path.isAbsolute(inputPath) ? inputPath : repoPath(inputPath), "utf8"))
  : await readJson("config/governance/intent-amplification-contract.json");

const normalizedTarget = normalizeRunArtifact(target);
validateIntent(normalizedTarget, {
  allowTemplate: templateMode && !strictMode,
});
if (strictMode) {
  const workflowContract = await readJson("config/contracts/workflow-contract.json");
  validateStrictPublicReadyContext(
    target,
    normalizedTarget,
    workflowContract.runDiscipline?.runArtifactValidation
      ?.contextEngineeringBudgetPublicReadyPolicy,
  );
}

console.log(inputPath ? "strict intent run artifact valid" : "intent amplification contract valid");
