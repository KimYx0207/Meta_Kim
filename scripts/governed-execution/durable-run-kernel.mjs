/**
 * Compatibility facade. The durable run repository implementation now lives
 * in src/data; keep this stable import path for existing packaged consumers.
 */
export {
  DURABLE_RUN_KERNEL_SCHEMA_VERSION,
  isAttestedDurableRunProjection,
  isAttestedDurableRunResume,
  openDurableRunKernel,
  openDurableRunRepository,
} from "../../src/application/run/open-durable-run-repository.mjs";
