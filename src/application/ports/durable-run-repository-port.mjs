import {
  DURABLE_RUN_REPOSITORY_REQUIRED_METHODS,
  DURABLE_RUN_REPOSITORY_SEMANTICS_SCHEMA_VERSION,
} from "../../domain/execution/durable-run-repository-semantics.mjs";

export function assertDurableRunRepositoryPort(repository) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("durable run repository must be an object");
  }
  for (const method of DURABLE_RUN_REPOSITORY_REQUIRED_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`durable run repository is missing method ${method}`);
    }
  }
  return repository;
}

export const DURABLE_RUN_REPOSITORY_PORT_SCHEMA_VERSION =
  DURABLE_RUN_REPOSITORY_SEMANTICS_SCHEMA_VERSION;
