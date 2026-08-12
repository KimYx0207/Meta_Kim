import { assertDurableRunRepositoryPort } from "../ports/durable-run-repository-port.mjs";
import {
  DURABLE_RUN_KERNEL_SCHEMA_VERSION,
  isAttestedDurableRunProjection,
  isAttestedDurableRunResume,
  openSqliteDurableRunRepository,
} from "../../data/repositories/sqlite-durable-run-repository.mjs";

export async function openDurableRunRepository(dbPath = ":memory:", options = {}) {
  return assertDurableRunRepositoryPort(
    await openSqliteDurableRunRepository(dbPath, options),
  );
}

export const openDurableRunKernel = openDurableRunRepository;

export {
  DURABLE_RUN_KERNEL_SCHEMA_VERSION,
  isAttestedDurableRunProjection,
  isAttestedDurableRunResume,
};
