import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import {
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createContentCache } from "../core/cache/content-cache.mjs";

async function temporaryCache(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mashirobot-content-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    cache: createContentCache({
      root,
      namespace: "pictures",
      maxEntries: 20,
      maxBytes: 1024 * 1024,
      ...options,
    }),
  };
}

test("uses stable object ordering and includes the caller version in the hash", async (t) => {
  const { cache } = await temporaryCache(t);
  let calls = 0;
  const create = async ({ outputPaths }) => {
    calls += 1;
    await writeFile(outputPaths[0], "complete");
  };

  const first = await cache.getOrCreate({
    keyPayload: { b: 2, nested: { z: 3, a: 1 } },
    version: 7,
    extension: ".png",
    create,
  });
  const reordered = await cache.getOrCreate({
    keyPayload: { nested: { a: 1, z: 3 }, b: 2 },
    version: 7,
    extension: ".png",
    create,
  });
  const changedVersion = await cache.getOrCreate({
    keyPayload: { b: 2, nested: { z: 3, a: 1 } },
    version: 8,
    extension: ".png",
    create,
  });

  assert.equal(calls, 2);
  assert.deepEqual(first, reordered);
  assert.notDeepEqual(first, changedVersion);
  assert.match(path.basename(path.dirname(first[0])), /^[a-f0-9]{64}$/u);
});

test("deduplicates concurrent creation and publishes only after completion", async (t) => {
  const { root, cache } = await temporaryCache(t);
  let calls = 0;
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  const create = async ({ outputPaths }) => {
    calls += 1;
    await writeFile(outputPaths[0], "complete");
    started();
    await ready;
  };

  const leftPromise = cache.getOrCreate({
    keyPayload: { b: 2, a: 1 },
    version: "renderer-v1",
    extension: ".png",
    create,
  });
  const rightPromise = cache.getOrCreate({
    keyPayload: { a: 1, b: 2 },
    version: "renderer-v1",
    extension: ".png",
    create,
  });
  await didStart;

  const namespaceEntries = readdirSync(path.join(root, "pictures"));
  assert.ok(namespaceEntries.some((name) => name.startsWith(".staging-")));
  assert.equal(namespaceEntries.some((name) => /^[a-f0-9]{64}$/u.test(name)), false);

  release();
  const [left, right] = await Promise.all([leftPromise, rightPromise]);
  assert.equal(calls, 1);
  assert.deepEqual(left, right);
  assert.ok(left.every((item) => existsSync(item)));
});

test("does not reuse an empty or partial cache entry", async (t) => {
  const { cache } = await temporaryCache(t);
  let calls = 0;
  const createTwoPages = async ({ outputPaths, stagingRoot, hash, extension }) => {
    calls += 1;
    const second = path.join(stagingRoot, `${hash}-2${extension}`);
    await writeFile(outputPaths[0], `page-one-${calls}`);
    await writeFile(second, `page-two-${calls}`);
    return [outputPaths[0], second];
  };
  const request = {
    keyPayload: { report: "weekly" },
    version: 1,
    extension: ".png",
    create: createTwoPages,
  };

  const first = await cache.getOrCreate(request);
  unlinkSync(first[1]);
  const rebuilt = await cache.getOrCreate(request);
  assert.equal(calls, 2);
  assert.equal(await readFile(rebuilt[1], "utf8"), "page-two-2");

  unlinkSync(rebuilt[0]);
  await writeFile(rebuilt[0], "");
  const rebuiltEmpty = await cache.getOrCreate(request);
  assert.equal(calls, 3);
  assert.equal(await readFile(rebuiltEmpty[0], "utf8"), "page-one-3");
});

test("rejects empty creator output without publishing a reusable entry", async (t) => {
  const { root, cache } = await temporaryCache(t);
  await assert.rejects(
    cache.getOrCreate({
      keyPayload: { empty: true },
      version: 1,
      extension: ".png",
      create: async ({ outputPaths }) => writeFile(outputPaths[0], ""),
    }),
    /nonempty|non-empty/iu,
  );

  const published = readdirSync(path.join(root, "pictures"))
    .filter((name) => /^[a-f0-9]{64}$/u.test(name));
  assert.deepEqual(published, []);
});

test("evicts oldest entries to satisfy both count and byte limits", async (t) => {
  let clock = Date.UTC(2026, 8, 16, 0, 0, 0);
  const { root, cache } = await temporaryCache(t, {
    maxEntries: 2,
    maxBytes: 7,
    now: () => clock,
  });
  const make = async (id, contents) => {
    clock += 1_000;
    return cache.getOrCreate({
      keyPayload: { id },
      version: 1,
      extension: ".bin",
      create: async ({ outputPaths }) => writeFile(outputPaths[0], contents),
    });
  };

  const first = await make(1, "1111");
  const second = await make(2, "2222");
  assert.equal(existsSync(first[0]), false, "byte limit evicts the oldest entry");
  assert.equal(existsSync(second[0]), true);

  const third = await make(3, "3");
  const fourth = await make(4, "4");
  assert.equal(existsSync(second[0]), false, "entry limit evicts the oldest survivor");
  assert.equal(existsSync(third[0]), true);
  assert.equal(existsSync(fourth[0]), true);
  const entries = readdirSync(path.join(root, "pictures"))
    .filter((name) => /^[a-f0-9]{64}$/u.test(name));
  assert.equal(entries.length, 2);
});

test("copyForUse creates unique copies without exposing cached originals", async (t) => {
  const { root, cache } = await temporaryCache(t);
  const cached = await cache.getOrCreate({
    keyPayload: { asset: 1 },
    version: 1,
    extension: ".png",
    create: async ({ outputPaths }) => writeFile(outputPaths[0], "image"),
  });
  const targetRoot = path.join(root, "outbound");
  const [first] = cache.copyForUse(cached, { targetRoot });
  const [second] = cache.copyForUse(cached, { targetRoot });

  assert.notEqual(first, second);
  assert.equal(path.extname(first), ".png");
  assert.equal(await readFile(first, "utf8"), "image");
  assert.equal(await readFile(second, "utf8"), "image");
  rmSync(first);
  assert.ok(existsSync(cached[0]));
});

for (const limits of [
  { name: "entry count", maxEntries: 1, maxBytes: 1024 },
  { name: "total bytes", maxEntries: 10, maxBytes: 5 },
]) {
  test(`protects all concurrent results from ${limits.name} eviction until immediate copy`, async (t) => {
    const { root, cache } = await temporaryCache(t, limits);
    let started = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let bothStarted;
    const ready = new Promise((resolve) => { bothStarted = resolve; });
    const request = (id) => cache.getOrCreate({
      keyPayload: { id },
      version: 1,
      extension: ".bin",
      create: async ({ outputPaths }) => {
        await writeFile(outputPaths[0], "data");
        started += 1;
        if (started === 2) bothStarted();
        await gate;
      },
    });

    const pending = Promise.all([request("left"), request("right")]);
    await ready;
    release();
    const [left, right] = await pending;
    const targetRoot = path.join(root, "outbound");
    const leftCopy = cache.copyForUse(left, { targetRoot });
    const rightCopy = cache.copyForUse(right, { targetRoot });
    assert.ok(leftCopy.every(existsSync));
    assert.ok(rightCopy.every(existsSync));
  });
}

test("copyForUse rejects paths outside the namespace and files absent from the manifest", async (t) => {
  const { root, cache } = await temporaryCache(t);
  const cached = await cache.getOrCreate({
    keyPayload: { trusted: true },
    version: 1,
    extension: ".png",
    create: async ({ outputPaths }) => writeFile(outputPaths[0], "trusted"),
  });
  const targetRoot = path.join(root, "outbound");
  const outside = path.join(root, "outside.png");
  writeFileSync(outside, "outside");
  assert.throws(() => cache.copyForUse([outside], { targetRoot }), /namespace|cache/iu);

  const fake = path.join(path.dirname(cached[0]), "fake.png");
  writeFileSync(fake, "fake");
  assert.throws(() => cache.copyForUse([fake], { targetRoot }), /manifest/iu);

  writeFileSync(cached[0], "different-size");
  assert.throws(() => cache.copyForUse(cached, { targetRoot }), /size|manifest/iu);
});

test("copyForUse rejects symbolic links even when they resolve into the cache", async (t) => {
  const { root, cache } = await temporaryCache(t);
  const cached = await cache.getOrCreate({
    keyPayload: { trusted: true },
    version: 1,
    extension: ".png",
    create: async ({ outputPaths }) => writeFile(outputPaths[0], "trusted"),
  });
  const link = path.join(path.dirname(cached[0]), "linked.png");
  try {
    symlinkSync(cached[0], link, "file");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("this Windows account cannot create a file symlink");
      return;
    }
    throw error;
  }
  assert.throws(
    () => cache.copyForUse([link], { targetRoot: path.join(root, "outbound") }),
    /symbolic|manifest/iu,
  );
});

test("two cache instances publish the same hash through one exclusive creator", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mashirobot-content-cache-race-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { root, namespace: "pictures", maxEntries: 20, maxBytes: 1024 * 1024 };
  const left = createContentCache(options);
  const right = createContentCache(options);
  let calls = 0;
  const create = async ({ outputPaths }) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    await writeFile(outputPaths[0], "winner");
  };
  const request = {
    keyPayload: { shared: true },
    version: 1,
    extension: ".png",
    create,
  };

  const [leftPaths, rightPaths] = await Promise.all([
    left.getOrCreate(request),
    right.getOrCreate(request),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(leftPaths, rightPaths);
  assert.equal(await readFile(leftPaths[0], "utf8"), "winner");
});

test("recovers an abandoned stale publication lock within a bounded wait", async (t) => {
  const { root, cache } = await temporaryCache(t, {
    lockWaitMs: 500,
    staleLockMs: 20,
    lockPollMs: 5,
  });
  const first = await cache.getOrCreate({
    keyPayload: { lock: "stale" },
    version: 1,
    extension: ".png",
    create: async ({ outputPaths }) => writeFile(outputPaths[0], "first"),
  });
  const hash = path.basename(path.dirname(first[0]));
  rmSync(path.dirname(first[0]), { recursive: true, force: true });
  const lock = path.join(root, "pictures", `.${hash}.lock`);
  mkdirSync(path.dirname(lock), { recursive: true });
  writeFileSync(lock, "abandoned");
  const old = new Date(Date.now() - 1_000);
  utimesSync(lock, old, old);

  const rebuilt = await cache.getOrCreate({
    keyPayload: { lock: "stale" },
    version: 1,
    extension: ".png",
    create: async ({ outputPaths }) => writeFile(outputPaths[0], "rebuilt"),
  });
  assert.equal(await readFile(rebuilt[0], "utf8"), "rebuilt");
  assert.equal(existsSync(lock), false);
});

test("two cache instances do not evict different active hashes before immediate copies", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mashirobot-content-cache-cross-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { root, namespace: "pictures", maxEntries: 1, maxBytes: 5 };
  const left = createContentCache(options);
  const right = createContentCache(options);
  let started = 0;
  let release;
  let ready;
  const gate = new Promise((resolve) => { release = resolve; });
  const bothReady = new Promise((resolve) => { ready = resolve; });
  const request = (cache, id) => cache.getOrCreate({
    keyPayload: { id },
    version: 1,
    extension: ".bin",
    create: async ({ outputPaths }) => {
      await writeFile(outputPaths[0], "data");
      started += 1;
      if (started === 2) ready();
      await gate;
    },
  });

  const pending = Promise.all([request(left, "left"), request(right, "right")]);
  await bothReady;
  release();
  const [leftPaths, rightPaths] = await pending;
  assert.ok(left.copyForUse(leftPaths, { targetRoot: path.join(root, "out-left") }).every(existsSync));
  assert.ok(right.copyForUse(rightPaths, { targetRoot: path.join(root, "out-right") }).every(existsSync));
  await new Promise((resolve) => setTimeout(resolve, 75));
  const entries = readdirSync(path.join(root, "pictures"))
    .filter((name) => /^[a-f0-9]{64}$/u.test(name));
  assert.ok(entries.length <= 1, "the namespace eventually returns within both limits");
});

test("two stale-lock recoverers isolate one old owner and still run one creator", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mashirobot-content-cache-recover-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = {
    root, namespace: "pictures", maxEntries: 20, maxBytes: 1024,
    lockWaitMs: 1_000, staleLockMs: 30, lockPollMs: 5,
  };
  const seed = createContentCache(options);
  const request = {
    keyPayload: { shared: "stale-race" }, version: 1, extension: ".png",
    create: async ({ outputPaths }) => writeFile(outputPaths[0], "seed"),
  };
  const seeded = await seed.getOrCreate(request);
  const hash = path.basename(path.dirname(seeded[0]));
  rmSync(path.dirname(seeded[0]), { recursive: true, force: true });
  const lock = path.join(root, "pictures", `.${hash}.lock`);
  writeFileSync(lock, JSON.stringify({ token: "old-owner" }));
  const old = new Date(Date.now() - 2_000);
  utimesSync(lock, old, old);

  let calls = 0;
  const create = async ({ outputPaths }) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    await writeFile(outputPaths[0], "winner");
  };
  const raced = { ...request, create };
  const [left, right] = await Promise.all([
    createContentCache(options).getOrCreate(raced),
    createContentCache(options).getOrCreate(raced),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(left, right);
});

test("heartbeat prevents recovery of a slow but live publication owner", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mashirobot-content-cache-live-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = {
    root, namespace: "pictures", maxEntries: 20, maxBytes: 1024,
    lockWaitMs: 1_000, staleLockMs: 30, lockPollMs: 5,
  };
  let calls = 0;
  const request = {
    keyPayload: { shared: "slow-owner" }, version: 1, extension: ".png",
    create: async ({ outputPaths }) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 140));
      await writeFile(outputPaths[0], "slow-winner");
    },
  };
  const first = createContentCache(options).getOrCreate(request);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const second = createContentCache(options).getOrCreate(request);
  const [left, right] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(left, right);
});

test("recovers an orphaned stale recovery marker without deleting a live marker", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mashirobot-content-cache-marker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = {
    root, namespace: "pictures", maxEntries: 20, maxBytes: 1024,
    lockWaitMs: 300, staleLockMs: 30, lockPollMs: 5,
  };
  const seed = createContentCache(options);
  const seeded = await seed.getOrCreate({
    keyPayload: { marker: true }, version: 1, extension: ".png",
    create: async ({ outputPaths }) => writeFile(outputPaths[0], "seed"),
  });
  const hash = path.basename(path.dirname(seeded[0]));
  rmSync(path.dirname(seeded[0]), { recursive: true, force: true });
  const lock = path.join(root, "pictures", `.${hash}.lock`);
  const marker = `${lock}.recover`;
  writeFileSync(lock, JSON.stringify({ token: "abandoned-lock" }));
  writeFileSync(marker, JSON.stringify({ token: "crashed-recoverer", owner: 1 }));
  const old = new Date(Date.now() - 2_000);
  utimesSync(lock, old, old);
  utimesSync(marker, old, old);

  const rebuilt = await createContentCache(options).getOrCreate({
    keyPayload: { marker: true }, version: 1, extension: ".png",
    create: async ({ outputPaths }) => writeFile(outputPaths[0], "rebuilt"),
  });
  assert.equal(await readFile(rebuilt[0], "utf8"), "rebuilt");
  assert.equal(existsSync(marker), false);
});

test("does not remove a fresh recovery marker owned by a live recoverer", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mashirobot-content-cache-live-marker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = createContentCache({
    root, namespace: "pictures", maxEntries: 20, maxBytes: 1024,
    lockWaitMs: 35, staleLockMs: 200, lockPollMs: 5,
  });
  const seeded = await cache.getOrCreate({
    keyPayload: { marker: "live" }, version: 1, extension: ".png",
    create: async ({ outputPaths }) => writeFile(outputPaths[0], "seed"),
  });
  const hash = path.basename(path.dirname(seeded[0]));
  rmSync(path.dirname(seeded[0]), { recursive: true, force: true });
  const lock = path.join(root, "pictures", `.${hash}.lock`);
  const marker = `${lock}.recover`;
  writeFileSync(lock, JSON.stringify({ token: "old-lock" }));
  writeFileSync(marker, JSON.stringify({ token: "live-recoverer", pid: process.pid }));
  const old = new Date(Date.now() - 2_000);
  utimesSync(lock, old, old);

  await assert.rejects(
    cache.getOrCreate({
      keyPayload: { marker: "live" }, version: 1, extension: ".png",
      create: async ({ outputPaths }) => writeFile(outputPaths[0], "unexpected"),
    }),
    (error) => error?.code === "CACHE_LOCK_TIMEOUT",
  );
  assert.equal(existsSync(marker), true);
  assert.match(await readFile(marker, "utf8"), /live-recoverer/u);
});

test("a short-TTL use lease heartbeats throughout a long creator and survives until copy", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mashirobot-content-cache-lease-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = {
    root, namespace: "pictures", maxEntries: 1, maxBytes: 5,
    leaseTtlMs: 20, lockWaitMs: 1_000, staleLockMs: 30, lockPollMs: 5,
  };
  const left = createContentCache(options);
  const right = createContentCache(options);
  const slow = left.getOrCreate({
    keyPayload: { id: "slow" }, version: 1, extension: ".bin",
    create: async ({ outputPaths }) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      await writeFile(outputPaths[0], "data");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const fast = right.getOrCreate({
    keyPayload: { id: "fast" }, version: 1, extension: ".bin",
    create: async ({ outputPaths }) => writeFile(outputPaths[0], "data"),
  });
  const [slowPaths, fastPaths] = await Promise.all([slow, fast]);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(left.copyForUse(slowPaths, { targetRoot: path.join(root, "out-slow") }).every(existsSync));
  assert.ok(right.copyForUse(fastPaths, { targetRoot: path.join(root, "out-fast") }).every(existsSync));
});

test("lease cleanup failures are contained in copy and deferred cleanup paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mashirobot-content-cache-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const failure = Object.assign(new Error("busy"), { code: "EBUSY" });
  let removalAttempts = 0;
  const cache = createContentCache({
    root, namespace: "pictures", maxEntries: 20, maxBytes: 1024,
    removeSync: () => { removalAttempts += 1; throw failure; },
  });
  const request = (id) => cache.getOrCreate({
    keyPayload: { id }, version: 1, extension: ".bin",
    create: async ({ outputPaths }) => writeFile(outputPaths[0], "data"),
  });
  const [left, right] = await Promise.all([request("left"), request("right")]);
  assert.doesNotThrow(() => cache.copyForUse(left, { targetRoot: path.join(root, "out") }));
  assert.doesNotThrow(() => cache.copyForUse(right, { targetRoot: path.join(root, "out") }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(removalAttempts >= 2);
});

test("reports CACHE_LOCK_TIMEOUT when a real live lock remains past the deadline", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mashirobot-content-cache-timeout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = createContentCache({
    root, namespace: "pictures", maxEntries: 20, maxBytes: 1024,
    lockWaitMs: 35, staleLockMs: 2_000, lockPollMs: 5,
  });
  const probe = await cache.getOrCreate({
    keyPayload: { timeout: true }, version: 1, extension: ".png",
    create: async ({ outputPaths }) => writeFile(outputPaths[0], "probe"),
  });
  const hash = path.basename(path.dirname(probe[0]));
  rmSync(path.dirname(probe[0]), { recursive: true, force: true });
  writeFileSync(path.join(root, "pictures", `.${hash}.lock`), JSON.stringify({ token: "live-owner" }));

  await assert.rejects(
    cache.getOrCreate({
      keyPayload: { timeout: true }, version: 1, extension: ".png",
      create: async ({ outputPaths }) => writeFile(outputPaths[0], "unexpected"),
    }),
    (error) => error?.code === "CACHE_LOCK_TIMEOUT" && /\.lock/iu.test(error.message),
  );
});

test("refuses publication when the lock path is replaced with the same token", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mashirobot-content-cache-lost-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = createContentCache({ root, namespace: "pictures", maxEntries: 20, maxBytes: 1024 });

  await assert.rejects(
    cache.getOrCreate({
      keyPayload: { ownership: "lost" }, version: 1, extension: ".png",
      create: async ({ outputPaths, stagingRoot, hash }) => {
        await writeFile(outputPaths[0], "must-not-publish");
        const lock = path.join(path.dirname(stagingRoot), `.${hash}.lock`);
        const bytes = await readFile(lock);
        unlinkSync(lock);
        writeFileSync(lock, bytes);
      },
    }),
    (error) => error?.code === "CACHE_LOCK_LOST",
  );
  const published = readdirSync(path.join(root, "pictures"))
    .filter((name) => /^[a-f0-9]{64}$/u.test(name));
  assert.deepEqual(published, []);
});

for (const phase of ["post-open-recovery", "owner-snapshot"]) {
  test(`cleans an acquired lock when ${phase} probing throws`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mashirobot-content-cache-acquire-fault-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let injected = false;
    let heartbeatStarts = 0;
    let heartbeatStops = 0;
    const cache = createContentCache({
      root, namespace: "pictures", maxEntries: 20, maxBytes: 1024,
      lockPhaseHook(current) {
        if (!injected && current === phase) {
          injected = true;
          throw new Error(`injected ${phase} failure`);
        }
      },
      lockSetInterval(callback, delay) {
        heartbeatStarts += 1;
        return setInterval(callback, delay);
      },
      lockClearInterval(timer) {
        heartbeatStops += 1;
        clearInterval(timer);
      },
    });
    const request = {
      keyPayload: { acquireFault: phase }, version: 1, extension: ".png",
      create: async ({ outputPaths }) => writeFile(outputPaths[0], "recovered"),
    };

    await assert.rejects(cache.getOrCreate(request), new RegExp(`injected ${phase}`, "u"));
    const lockFiles = readdirSync(path.join(root, "pictures"))
      .filter((name) => name.endsWith(".lock"));
    assert.deepEqual(lockFiles, []);
    if (phase === "owner-snapshot") {
      assert.equal(heartbeatStarts, 1);
      assert.equal(heartbeatStops, 1);
    }

    const recovered = await cache.getOrCreate(request);
    assert.equal(await readFile(recovered[0], "utf8"), "recovered");
  });
}
