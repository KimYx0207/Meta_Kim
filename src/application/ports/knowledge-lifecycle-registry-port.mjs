export const KNOWLEDGE_LIFECYCLE_REGISTRY_REQUIRED_METHODS = Object.freeze([
  "read",
  "readSourceDigest",
  "compareAndSwap",
]);

export function assertKnowledgeLifecycleRegistryPort(repository) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("knowledge lifecycle registry repository must be an object");
  }
  for (const method of KNOWLEDGE_LIFECYCLE_REGISTRY_REQUIRED_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`knowledge lifecycle registry repository is missing method ${method}`);
    }
  }
  if (typeof repository.delete === "function" || typeof repository.remove === "function") {
    throw new TypeError("knowledge lifecycle registry repository must not expose delete/remove authority");
  }
  return repository;
}
