#!/usr/bin/env node
/** CLI adapter. Entry semantics are owned by the projectable shared application. */
import process from "node:process";
import { fileURLToPath } from "node:url";
import { classifyMetaTheoryEntry } from "../canonical/runtime-assets/shared/hooks/entry-classifier.mjs";
export { classifyMetaTheoryEntry, hasEngineeringRepairIntent, hasProductBuildIntent, validateEntryLexicon } from "../canonical/runtime-assets/shared/hooks/entry-classifier.mjs";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(classifyMetaTheoryEntry(process.argv.slice(2).join(" ")), null, 2)}\n`);
}
