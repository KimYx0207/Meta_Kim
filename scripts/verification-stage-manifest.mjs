// Shared smoke floor. Full release verification adds its own release proofs,
// but must execute every behavior check here with the same command.
const npmStage = (name) => Object.freeze({ name, cmd: `npm run ${name}` });

export const SMOKE_PREPARATION_STAGES = Object.freeze([
  npmStage("meta:sync"),
  npmStage("meta:agents:migration-catalog:check"),
]);

export const SMOKE_BEHAVIOR_STAGES = Object.freeze([
  npmStage("meta:capabilities:smoke"),
  npmStage("meta:test:inventory"),
  npmStage("meta:test:unit"),
  npmStage("meta:test:meta-theory"),
  npmStage("meta:test:integration"),
  npmStage("meta:test:live:coverage"),
]);

export const SMOKE_STAGES = Object.freeze([
  ...SMOKE_PREPARATION_STAGES,
  ...SMOKE_BEHAVIOR_STAGES,
]);

// CI is deterministic fixture/product regression, not installed-runtime or
// externally certified live-model acceptance. No file/path filters exclude
// prompt Markdown, which is executable product source in this repository.
export const CI_LANES = Object.freeze({
  // Capability smoke needs installed execution/creation providers. Preserve it
  // in smoke/full; CI runs the credential-free test suites, not an install proof.
  core: Object.freeze(SMOKE_BEHAVIOR_STAGES.filter(({ name }) => name.startsWith("meta:test:") && name !== "meta:test:live:coverage")),
  governance: Object.freeze([npmStage("meta:test:governance")]),
  live: Object.freeze(SMOKE_BEHAVIOR_STAGES.filter(({ name }) => name === "meta:test:live:coverage")),
});
