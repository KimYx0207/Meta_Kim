import { defineRuntimeAdapter } from "meta-kim/live-sdk";

/**
 * An independent community-style adapter. It maps an intentionally tiny
 * fixture shape and does not discover, launch, or claim a runtime.
 */
export const adapter = defineRuntimeAdapter({
  id: "example-runtime",
  version: "1.0.0",
  label: "Example Runtime",
  capabilities: ["normalize", "project"],
  normalize(input) {
    const status = input.state === "running" || input.state === "active" ? "running" : "unknown";
    const stage = typeof input.phase === "string" && input.phase.trim()
      ? input.phase.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || null
      : null;
    return {
      status,
      stage,
      observedAt: input.observedAt,
      summary: status === "running" ? "Example runtime is being observed." : "Example runtime state is unknown.",
      events: [],
    };
  },
});
