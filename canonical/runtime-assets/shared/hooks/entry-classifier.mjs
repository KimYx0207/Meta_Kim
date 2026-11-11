/** Data binding for the shared entry policy; no lifecycle or permission effects. */
import lexicon from "./entry-classification-lexicon.json" with { type: "json" };
import { createEntryClassifier } from "./entry-classifier-core.mjs";

export { validateEntryLexicon } from "./entry-classifier-core.mjs";
export const { classifyMetaTheoryEntry, hasEngineeringRepairIntent, hasProductBuildIntent } = createEntryClassifier(lexicon);
