function abortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function validateSignal(signal) {
  if (
    signal != null &&
    (typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  ) {
    throw new TypeError("signal must be an AbortSignal");
  }
}

function forCaller(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", aborted);
    const aborted = () => {
      cleanup();
      reject(abortError());
    };
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export class SingleFlightCache {
  #entries = new Map();
  #generations = new Map();
  #now;

  constructor({ now = Date.now } = {}) {
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.#now = now;
  }

  get(key, loader, { ttlMs = 0, signal } = {}) {
    if (typeof loader !== "function") throw new TypeError("loader must be a function");
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new TypeError("ttlMs must be a non-negative finite number");
    }
    validateSignal(signal);
    if (signal?.aborted) return Promise.reject(abortError());

    const now = this.#now();
    if (!Number.isFinite(now)) throw new TypeError("now() must return a finite number");
    const existing = this.#entries.get(key);
    if (existing?.kind === "pending") return forCaller(existing.promise, signal);
    if (existing?.kind === "value" && now < existing.expiresAt) {
      return forCaller(Promise.resolve(existing.value), signal);
    }
    if (existing) this.#entries.delete(key);

    const generation = this.#generations.get(key) ?? 0;
    let promise = Promise.resolve().then(() => loader());
    promise = promise.then(
      (value) => {
        const current = this.#entries.get(key);
        if (
          (this.#generations.get(key) ?? 0) === generation &&
          current?.kind === "pending" &&
          current.promise === promise
        ) {
          if (ttlMs > 0) {
            this.#entries.set(key, { kind: "value", value, expiresAt: now + ttlMs });
          } else {
            this.#entries.delete(key);
          }
        }
        return value;
      },
      (error) => {
        const current = this.#entries.get(key);
        if (current?.kind === "pending" && current.promise === promise) {
          this.#entries.delete(key);
        }
        throw error;
      },
    );
    this.#entries.set(key, { kind: "pending", promise });
    return forCaller(promise, signal);
  }

  invalidate(key) {
    this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1);
    this.#entries.delete(key);
  }
}
