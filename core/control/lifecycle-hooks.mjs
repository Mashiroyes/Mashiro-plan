function keyFor(owner, kind) {
  const ownerValue = String(owner ?? "").trim();
  const kindValue = String(kind ?? "").trim();
  if (!ownerValue || !kindValue) throw new TypeError("lifecycle hook owner and kind are required");
  return `${ownerValue}\0${kindValue}`;
}

export function createLifecycleHooks() {
  const acknowledgements = new Map();
  const shutdownHandlers = new Map();
  const currentTaskProviders = new Map();

  function registerUnique(collection, key, handler, label) {
    if (typeof handler !== "function") throw new TypeError(`${label} handler must be a function`);
    if (collection.has(key)) throw new Error(`duplicate ${label} handler: ${key.replace("\0", "/")}`);
    collection.set(key, handler);
  }

  return Object.freeze({
    registerAcknowledgement(owner, kind, handler) {
      registerUnique(acknowledgements, keyFor(owner, kind), handler, "acknowledgement");
    },
    async runAcknowledgement(reminder, context = {}) {
      const handler = acknowledgements.get(keyFor(reminder.sourcePlugin, reminder.kind));
      return handler ? await handler(reminder, context) : { cleanupPending: false };
    },
    registerShutdown(owner, handler) {
      const key = String(owner ?? "").trim();
      if (!key) throw new TypeError("shutdown hook owner is required");
      registerUnique(shutdownHandlers, key, handler, "shutdown");
    },
    registerCurrentTasks(owner, provider) {
      const key = String(owner ?? "").trim();
      if (!key) throw new TypeError("current-task provider owner is required");
      registerUnique(currentTaskProviders, key, provider, "current-task");
    },
    async collectCurrentTasks(context = {}) {
      const sections = [];
      for (const [owner, provider] of currentTaskProviders) {
        try {
          const provided = await provider(context);
          if (Array.isArray(provided)) sections.push(...provided);
        } catch (error) {
          sections.push({ title: owner, status: "unknown", items: [], error: String(error instanceof Error ? error.message : error) });
        }
      }
      return sections;
    },
    async shutdown(context = {}) {
      const failures = [];
      for (const [owner, handler] of shutdownHandlers) {
        try { await handler(context); } catch (error) {
          failures.push({ owner, error: String(error instanceof Error ? error.message : error) });
        }
      }
      return failures;
    },
  });
}
