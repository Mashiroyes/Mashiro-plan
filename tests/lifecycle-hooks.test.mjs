import assert from "node:assert/strict";
import test from "node:test";
import { createLifecycleHooks } from "../core/control/lifecycle-hooks.mjs";

test("dispatches acknowledgement to the owning plugin and rejects duplicates", async () => {
  const hooks = createLifecycleHooks();
  hooks.registerAcknowledgement("plan", "user", async (reminder) => ({ cleanupPending: reminder.id === "r1" }));
  assert.throws(() => hooks.registerAcknowledgement("plan", "user", () => {}), /duplicate acknowledgement/);
  assert.deepEqual(await hooks.runAcknowledgement({ id: "r1", sourcePlugin: "plan", kind: "user" }), { cleanupPending: true });
  assert.deepEqual(await hooks.runAcknowledgement({ id: "r2", sourcePlugin: "other", kind: "user" }), { cleanupPending: false });
});

test("shutdown hooks run once per owner and report failures", async () => {
  const hooks = createLifecycleHooks();
  hooks.registerShutdown("ok", async () => {});
  hooks.registerShutdown("bad", async () => { throw new Error("cleanup failed"); });
  const failures = await hooks.shutdown();
  assert.deepEqual(failures, [{ owner: "bad", error: "cleanup failed" }]);
});
