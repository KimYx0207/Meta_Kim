import assert from "node:assert/strict";
import { loadDependencyAgentMethod } from "../dependency-agent-discovery.mjs";
import { loadDependencySkillMethod } from "../dependency-skill-discovery.mjs";
import { buildMethodInvocationContext, appendMethodInvocationContext } from "./method-delivery.mjs";

const methodBinding = method => ({ ownerAgent: method.ownerAgent, sourceRef: method.sourceRef, contentDigest: method.contentDigest,
  componentVersion: method.componentVersion ?? null, componentContentSha256: method.componentContentSha256, capabilityId: method.capabilityId, methodSha256: method.methodSha256,
  methodStatus: method.methodStatus, knowledgeAssets: (method.knowledgeAssets ?? []).map(({ id, path, sha256, bytes }) => ({ id, path, sha256, bytes })) });

/** Compose the same source-verified method used by the runtime adapter into
 * ordinary host messages after the final task/design projection. */
export async function prepareHostMethodHandoff({ packet, projectRoot, environment = process.env }) {
  const selected = [...new Map([...(packet.skillLoadout ?? []), ...(packet.capabilityBindings?.skills ?? [])]
    .filter(provider => provider?.source === "dependency_skill_contract").map(provider => [provider.id, provider])).values()];
  const primarySkill = selected.find(provider => packet.methodCapabilityId === provider.id || packet.methodCapabilityId === provider.id.split(":").at(-1));
  const withoutPrimaryInputs = value => {
    const result = { ...value }; delete result.methodInputs; delete result.methodCapabilityId; delete result.methodKnowledgeAssetIds;
    return result;
  };
  const agent = await loadDependencyAgentMethod({ packet: primarySkill ? withoutPrimaryInputs(packet) : packet, projectRoot, environment });
  const skillMethods = await Promise.all(selected.map(provider => loadDependencySkillMethod({ provider,
    packet: provider === primarySkill ? packet : withoutPrimaryInputs(packet), projectRoot, environment })));
  const primary = primarySkill ? skillMethods.find(method => method.capabilityId === primarySkill.id) : agent;
  if (!primary && !skillMethods.length) return null;
  if (packet.hostOperation) {
    assert(primary, "Current host operation requires a source-bound professional method");
    for (const field of ["ownerAgent", "contentDigest", "componentContentSha256", "capabilityId"]) {
      assert.equal(packet.hostOperation.methodSource[field], primary[field], `Current host operation method source differs: ${field}`);
    }
    assert.equal(packet.hostOperation.executionAuthorized, false, "Method handoff cannot grant host execution authorization");
  }
  const context = primary ? buildMethodInvocationContext({ method: primary, packet }) : null;
  const supporting = [...(primarySkill && agent ? [agent] : []), ...skillMethods.filter(method => method !== primary)];
  let prompt = primary ? appendMethodInvocationContext(`Selected professional source (SHA-256 ${primary.contentDigest}):\n${primary.sourceText}`, context) : "";
  for (const method of supporting) prompt += `\nSupporting source method (reference only; inputs not invoked, no additional permission):\n${method.sourceText}\n${JSON.stringify({ method: method.method, knowledgeAssets: method.knowledgeAssets, inputContract: method.inputContract, outputContract: method.outputContract })}`;
  return { prompt, binding: { schemaVersion: "host-method-handoff-v1", ...(primary ? methodBinding(primary) : {}),
    methodInputStatus: context?.status ?? "reference_only", methodInputProblems: context?.inputProblems ?? [], supportingSkills: supporting.map(methodBinding),
    canExecute: false, invocationStatus: "not_invoked", methodDelivery: "prepared_host_message", methodProvidedToRuntime: false,
    nativeInvocationVerified: false, acceptanceStatus: "pending_independent_review" } };
}
