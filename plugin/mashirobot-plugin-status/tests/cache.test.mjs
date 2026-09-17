import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStatusCache } from "../core/status-cache.mjs";

test("status expires after 5 seconds while hardware remains fresh for 24 hours", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "status-cache-"));
  let now = Date.parse("2026-09-16T00:00:00Z");
  try {
    const cache = createStatusCache({ root, now: () => now });
    await cache.write("status", { capturedAt: new Date(now).toISOString(), value: 1 });
    await cache.write("hardware", { capturedAt: new Date(now).toISOString(), value: 2 });
    now += 6_000;
    assert.equal((await cache.read("status")).fresh, false);
    assert.equal((await cache.read("hardware")).fresh, true);
    now += 86_400_000;
    assert.equal((await cache.read("hardware")).fresh, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("cache rejects malformed and future-dated records and publishes atomically", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "status-cache-invalid-"));
  const now = Date.parse("2026-09-16T00:00:00Z");
  try {
    const cache = createStatusCache({ root, now: () => now });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "status.json"), "not json");
    assert.equal(await cache.read("status"), null);
    fs.writeFileSync(path.join(root, "status.json"), JSON.stringify({ capturedAt: "2099-01-01T00:00:00Z", writtenAt: "2099-01-01T00:00:00Z", data: {} }));
    assert.equal(await cache.read("status"), null);
    await cache.write("status", { value: 3 });
    assert.equal((await cache.read("status")).data.value, 3);
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
