import { defineReplayTheme } from "meta-kim/live-sdk";

/**
 * An independent structured replay theme. It returns safe text tokens rather
 * than HTML so each host can render with textContent or an equivalent API.
 */
export const theme = defineReplayTheme({
  id: "example-replay-theme",
  version: "1.0.0",
  label: "Example timeline",
  capabilities: ["render"],
  render(frame) {
    const tone = frame.status === "completed"
      ? "success"
      : frame.status === "failed" || frame.status === "blocked"
        ? "danger"
        : frame.status === "running"
          ? "active"
          : "neutral";
    return {
      title: frame.label,
      tone,
      marker: frame.status === "completed" ? "✓" : frame.status === "running" ? "…" : "•",
    };
  },
});
