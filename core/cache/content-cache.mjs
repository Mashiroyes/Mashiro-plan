import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const MANIFEST_NAME = ".manifest.json";
const MANIFEST_VERSION = 1;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_LOCK_WAIT_MS = 45_000;
const DEFAULT_STALE_LOCK_MS = 120_000;
const DEFAULT_LOCK_POLL_MS = 25;
const RETURN_LEASE_MS = 30_000;
const namespaceStates = new Map();

function sharedNamespaceState(namespaceRoot) {
  let state = namespaceStates.get(namespaceRoot);
  if (!state) {
    state = {
      activeRequests: new Map(),
      returnLeases: new Map(),
      evictionTail: Promise.resolve(),
    };
    namespaceStates.set(namespaceRoot, state);
  }
  return state;
}

function stableValue(value, seen = new Set()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("keyPayload must not contain cycles");
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) throw new TypeError("keyPayload must not contain cycles");
    seen.add(value);
    const result = Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, stableValue(value[key], seen)]),
    );
    seen.delete(value);
    return result;
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function contentHash(keyPayload, version) {
  const serialized = stableJson({ keyPayload, version });
  if (serialized === undefined) throw new TypeError("keyPayload must be JSON serializable");
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

function positiveLimit(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function normalizeNamespace(value) {
  const namespace = String(value ?? "").trim();
  if (!namespace || !/^[A-Za-z0-9._-]+$/u.test(namespace)) {
    throw new TypeError("namespace must contain only letters, digits, dot, dash, or underscore");
  }
  return namespace;
}

function normalizeExtension(value) {
  const extension = String(value ?? "");
  if (!/^\.[A-Za-z0-9]+$/u.test(extension)) {
    throw new TypeError("extension must be a simple dot-prefixed file extension");
  }
  return extension.toLowerCase();
}

function nowMilliseconds(now) {
  const value = typeof now === "function" ? now() : now;
  const milliseconds = value instanceof Date ? value.getTime() : Number(value ?? Date.now());
  if (!Number.isFinite(milliseconds)) throw new TypeError("now must resolve to a valid time");
  return milliseconds;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function pageNumber(name, hash, extension) {
  const match = new RegExp(`^${hash}-(\\d+)${extension.replace(".", "\\.")}$`, "u").exec(name);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function outputOrder(left, right, hash, extension) {
  const byPage = pageNumber(path.basename(left), hash, extension)
    - pageNumber(path.basename(right), hash, extension);
  return byPage || path.basename(left).localeCompare(path.basename(right), "en");
}

async function regularNonempty(filePath) {
  try {
    const details = await lstat(filePath);
    return details.isFile() && details.size > 0 ? details : null;
  } catch {
    return null;
  }
}

async function readValidEntry(entryRoot, hash) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(entryRoot, MANIFEST_NAME), "utf8"));
  } catch {
    return null;
  }
  if (
    manifest?.manifestVersion !== MANIFEST_VERSION
    || manifest?.hash !== hash
    || !Array.isArray(manifest.files)
    || manifest.files.length === 0
  ) return null;

  const paths = [];
  let totalBytes = 0;
  for (const item of manifest.files) {
    if (!item || typeof item.name !== "string" || path.basename(item.name) !== item.name) return null;
    const candidate = path.join(entryRoot, item.name);
    const details = await regularNonempty(candidate);
    if (!details || details.size !== item.size) return null;
    paths.push(candidate);
    totalBytes += details.size;
  }
  return { paths, totalBytes, accessedAt: Number(manifest.accessedAt) || 0 };
}

async function discoverOutputs(stagingRoot, hash, extension) {
  const entries = await readdir(stagingRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(stagingRoot, entry.name))
    .sort((left, right) => outputOrder(left, right, hash, extension));
}

function normalizeCreatedPaths(created, fallback) {
  if (Array.isArray(created)) return created;
  if (typeof created === "string") return [created];
  if (Array.isArray(created?.outputPaths)) return created.outputPaths;
  return fallback;
}

/**
 * Create a bounded, hash-addressed cache whose entries are atomically published directories.
 */
export function createContentCache({
  root,
  namespace,
  maxEntries = 100,
  maxBytes = 100 * 1024 * 1024,
  now = Date.now,
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
  staleLockMs = DEFAULT_STALE_LOCK_MS,
  lockPollMs = DEFAULT_LOCK_POLL_MS,
  leaseTtlMs = RETURN_LEASE_MS,
  removeSync = rmSync,
  lockPhaseHook = null,
  lockSetInterval = setInterval,
  lockClearInterval = clearInterval,
} = {}) {
  if (!root) throw new TypeError("root is required");
  const namespaceName = normalizeNamespace(namespace);
  const entryLimit = positiveLimit(maxEntries, 100, "maxEntries");
  const byteLimit = positiveLimit(maxBytes, 100 * 1024 * 1024, "maxBytes");
  const lockWait = positiveLimit(lockWaitMs, DEFAULT_LOCK_WAIT_MS, "lockWaitMs");
  const staleLock = positiveLimit(staleLockMs, DEFAULT_STALE_LOCK_MS, "staleLockMs");
  const lockPoll = positiveLimit(lockPollMs, DEFAULT_LOCK_POLL_MS, "lockPollMs");
  const leaseTtl = positiveLimit(leaseTtlMs, RETURN_LEASE_MS, "leaseTtlMs");
  if (typeof removeSync !== "function") throw new TypeError("removeSync must be a function");
  if (lockPhaseHook !== null && typeof lockPhaseHook !== "function") {
    throw new TypeError("lockPhaseHook must be a function or null");
  }
  if (typeof lockSetInterval !== "function" || typeof lockClearInterval !== "function") {
    throw new TypeError("lock timer functions must be callable");
  }
  const namespaceRoot = path.join(path.resolve(String(root)), namespaceName);
  const flights = new Map();
  const sharedState = sharedNamespaceState(namespaceRoot);
  const activeRequests = sharedState.activeRequests;
  const returnLeases = sharedState.returnLeases;
  const ownedLeases = new Map();

  async function beginRequest(hash) {
    activeRequests.set(hash, (activeRequests.get(hash) ?? 0) + 1);
    try {
      await mkdir(namespaceRoot, { recursive: true });
      const leasePath = path.join(namespaceRoot, `.use-${hash}-${randomUUID()}.lease`);
      await writeFile(leasePath, `${JSON.stringify({ hash, pid: process.pid, createdAt: Date.now() })}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      const heartbeatMs = Math.max(5, Math.floor(leaseTtl / 3));
      const heartbeat = setInterval(() => {
        const time = new Date();
        utimes(leasePath, time, time).catch(() => {});
      }, heartbeatMs);
      heartbeat.unref?.();
      const lease = { path: leasePath, heartbeat };
      const paths = ownedLeases.get(hash) ?? [];
      paths.push(lease);
      ownedLeases.set(hash, paths);
      return lease;
    } catch (error) {
      const remaining = (activeRequests.get(hash) ?? 1) - 1;
      if (remaining > 0) activeRequests.set(hash, remaining);
      else activeRequests.delete(hash);
      throw error;
    }
  }

  function activeRequestCount() {
    return [...activeRequests.values()].reduce((sum, count) => sum + count, 0);
  }

  function removeOwnedLease(hash, lease) {
    const paths = ownedLeases.get(hash) ?? [];
    const index = paths.indexOf(lease);
    if (index >= 0) paths.splice(index, 1);
    if (paths.length === 0) ownedLeases.delete(hash);
    else ownedLeases.set(hash, paths);
    clearInterval(lease.heartbeat);
    try {
      removeSync(lease.path, { force: true });
    } catch {
      // Lease cleanup is best-effort; TTL-based eviction will ignore it later.
    }
  }

  function releaseOneLease(hash) {
    const leases = returnLeases.get(hash);
    const owned = new Set(ownedLeases.get(hash) ?? []);
    const lease = leases && [...leases].find((item) => owned.has(item.owner));
    if (!lease) return;
    clearTimeout(lease.timer);
    leases.delete(lease);
    if (leases.size === 0) returnLeases.delete(hash);
    removeOwnedLease(hash, lease.owner);
    scheduleEviction().catch(() => {});
  }

  function addReturnLease(hash, owner) {
    const leases = returnLeases.get(hash) ?? new Set();
    const timer = setTimeout(() => {
      leases.delete(lease);
      if (leases.size === 0) returnLeases.delete(hash);
      removeOwnedLease(hash, owner);
      scheduleEviction().catch(() => {});
    }, RETURN_LEASE_MS);
    timer.unref?.();
    const lease = { timer, owner };
    leases.add(lease);
    returnLeases.set(hash, leases);
  }

  function finishRequest(hash, owner, succeeded) {
    const overlapped = activeRequestCount() > 1 || returnLeases.size > 0;
    const remaining = (activeRequests.get(hash) ?? 1) - 1;
    if (remaining > 0) activeRequests.set(hash, remaining);
    else activeRequests.delete(hash);
    if (succeeded && overlapped) {
      try {
        const time = new Date();
        utimes(owner.path, time, time).catch(() => {});
      } catch {
        // The disk lease is best-effort; in-process protection remains active.
      }
      addReturnLease(hash, owner);
    } else {
      setImmediate(() => {
        removeOwnedLease(hash, owner);
        scheduleEviction().catch(() => {});
      });
    }
  }

  async function touchEntry(entryRoot) {
    const time = new Date(nowMilliseconds(now));
    try {
      await utimes(entryRoot, time, time);
    } catch {
      // Cache recency is best-effort; a valid hit remains usable.
    }
  }

  async function validHit(hash) {
    const entryRoot = path.join(namespaceRoot, hash);
    const entry = await readValidEntry(entryRoot, hash);
    if (!entry) return null;
    await touchEntry(entryRoot);
    return entry.paths;
  }

  async function evict() {
    await mkdir(namespaceRoot, { recursive: true });
    const evictionLock = await acquireExclusiveLock(path.join(namespaceRoot, ".eviction.lock"));
    try {
      const names = await readdir(namespaceRoot, { withFileTypes: true });
      const diskProtected = new Set();
      for (const item of names) {
        const leaseMatch = /^\.use-([a-f0-9]{64})-.+\.lease$/u.exec(item.name);
        const lockMatch = /^\.([a-f0-9]{64})\.lock$/u.exec(item.name);
        if (lockMatch) diskProtected.add(lockMatch[1]);
        if (!leaseMatch || !item.isFile()) continue;
        const leasePath = path.join(namespaceRoot, item.name);
        try {
          const details = await lstat(leasePath);
          if (Date.now() - details.mtimeMs <= leaseTtl) diskProtected.add(leaseMatch[1]);
          else await rm(leasePath, { force: true });
        } catch {
          // A lease can disappear when its owner completes the outbound copy.
        }
      }
      const entries = [];
      for (const item of names) {
        if (!item.isDirectory() || !HASH_PATTERN.test(item.name)) continue;
        const entryRoot = path.join(namespaceRoot, item.name);
        const valid = await readValidEntry(entryRoot, item.name);
        if (!valid) {
          await rm(entryRoot, { recursive: true, force: true });
          continue;
        }
        let modifiedAt = valid.accessedAt;
        try {
          modifiedAt = (await stat(entryRoot)).mtimeMs;
        } catch {
          // If it vanished concurrently, the next accounting pass will omit it.
        }
        entries.push({ hash: item.name, root: entryRoot, bytes: valid.totalBytes, modifiedAt });
      }

      entries.sort((left, right) => left.modifiedAt - right.modifiedAt || left.hash.localeCompare(right.hash));
      let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
      let totalEntries = entries.length;
      for (const entry of entries) {
        if (totalEntries <= entryLimit && totalBytes <= byteLimit) break;
        if (activeRequests.has(entry.hash) || returnLeases.has(entry.hash) || diskProtected.has(entry.hash)) continue;
        await rm(entry.root, { recursive: true, force: true });
        totalEntries -= 1;
        totalBytes -= entry.bytes;
      }
    } finally {
      await evictionLock.release();
    }
  }

  function scheduleEviction() {
    const pending = sharedState.evictionTail.then(() => evict());
    sharedState.evictionTail = pending.catch(() => {});
    return pending;
  }

  function pause(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function lockSnapshot(lockPath) {
    let handle;
    try {
      handle = await open(lockPath, "r");
      const [details, raw] = await Promise.all([
        handle.stat(),
        handle.readFile("utf8"),
      ]);
      let token = raw;
      try {
        token = JSON.parse(raw)?.token ?? raw;
      } catch {
        // A legacy or interrupted lock is identified by its raw bytes.
      }
      return {
        token: String(token),
        dev: details.dev,
        ino: details.ino,
        birthtimeMs: details.birthtimeMs,
        mtimeMs: details.mtimeMs,
      };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  function sameLock(left, right) {
    return Boolean(left && right
      && left.token === right.token
      && left.dev === right.dev
      && left.ino === right.ino
      && left.birthtimeMs === right.birthtimeMs);
  }

  function sameFileIdentity(left, right) {
    return Boolean(left && right
      && left.dev === right.dev
      && left.ino === right.ino
      && left.birthtimeMs === right.birthtimeMs);
  }

  async function removeLockIfToken(lockPath, token) {
    const current = await lockSnapshot(lockPath);
    if (current?.token === token) await rm(lockPath, { force: true });
  }

  async function recoverOrphanMarker(markerPath, observed) {
    const quarantine = `${markerPath}.stale-${randomUUID()}`;
    try {
      await rename(markerPath, quarantine);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    const isolated = await lockSnapshot(quarantine);
    if (!sameLock(isolated, observed) || Date.now() - isolated.mtimeMs <= staleLock) {
      try {
        await rename(quarantine, markerPath);
      } catch {
        // Preserve unexpected ownership in quarantine rather than deleting it.
      }
      return false;
    }
    await rm(quarantine, { force: true });
    return true;
  }

  async function recoveryInProgress(markerPath) {
    const observed = await lockSnapshot(markerPath);
    if (!observed) return false;
    if (Date.now() - observed.mtimeMs <= staleLock) return true;
    await recoverOrphanMarker(markerPath, observed);
    return Boolean(await lockSnapshot(markerPath));
  }

  async function recoverStaleLock(lockPath, observed) {
    const markerPath = `${lockPath}.recover`;
    const markerToken = randomUUID();
    let marker;
    let markerHeartbeat;
    try {
      marker = await open(markerPath, "wx");
      try {
        await marker.writeFile(`${JSON.stringify({
          token: markerToken,
          pid: process.pid,
          createdAt: Date.now(),
        })}\n`, "utf8");
      } catch (error) {
        await marker.close().catch(() => {});
        await rm(markerPath, { force: true }).catch(() => {});
        throw error;
      }
      const heartbeatMs = Math.max(5, Math.floor(staleLock / 3));
      markerHeartbeat = setInterval(() => {
        const time = new Date();
        marker.utimes(time, time).catch(() => {});
      }, heartbeatMs);
      markerHeartbeat.unref?.();
    } catch (error) {
      await marker?.close().catch(() => {});
      if (error?.code === "EEXIST") return false;
      throw error;
    }
    try {
      const current = await lockSnapshot(lockPath);
      if (!sameLock(current, observed) || Date.now() - current.mtimeMs <= staleLock) return false;
      const quarantine = `${lockPath}.stale-${randomUUID()}`;
      try {
        await rename(lockPath, quarantine);
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
      const isolated = await lockSnapshot(quarantine);
      if (!sameLock(isolated, current)) {
        try {
          await rename(quarantine, lockPath);
        } catch {
          // Keep the unexpected file isolated instead of deleting unknown ownership.
        }
        return false;
      }
      await rm(quarantine, { force: true });
      return true;
    } finally {
      clearInterval(markerHeartbeat);
      await marker.close().catch(() => {});
      await removeLockIfToken(markerPath, markerToken).catch(async () => {
        await rm(markerPath, { force: true }).catch(() => {});
      });
    }
  }

  async function acquireExclusiveLock(lockPath, winnerCheck = null) {
    const deadline = Date.now() + lockWait;
    while (true) {
      const winner = await winnerCheck?.();
      if (winner) return { winner };
      const markerPath = `${lockPath}.recover`;
      if (await recoveryInProgress(markerPath)) {
        if (Date.now() >= deadline) {
          const error = new Error(`cache lock timed out: ${path.basename(lockPath)}`);
          error.code = "CACHE_LOCK_TIMEOUT";
          throw error;
        }
        await pause(lockPoll);
        continue;
      }
      const token = randomUUID();
      let handle;
      try {
        handle = await open(lockPath, "wx");
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }

      if (handle) {
        let heartbeat = null;
        let ownershipTransferred = false;
        let openedIdentity = null;
        try {
          const openedDetails = await handle.stat();
          openedIdentity = {
            dev: openedDetails.dev,
            ino: openedDetails.ino,
            birthtimeMs: openedDetails.birthtimeMs,
          };
          await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: Date.now() })}\n`, "utf8");
          await lockPhaseHook?.("post-open-recovery", { lockPath, token });
          if (await recoveryInProgress(markerPath)) {
            await pause(lockPoll);
            continue;
          }
          const heartbeatMs = Math.max(5, Math.floor(staleLock / 3));
          heartbeat = lockSetInterval(() => {
            const time = new Date();
            handle.utimes(time, time).catch(() => {});
          }, heartbeatMs);
          heartbeat?.unref?.();
          await lockPhaseHook?.("owner-snapshot", { lockPath, token });
          const ownerIdentity = await lockSnapshot(lockPath);
          if (!sameFileIdentity(ownerIdentity, openedIdentity) || ownerIdentity?.token !== token) {
            const error = new Error(`cache lock ownership was lost: ${path.basename(lockPath)}`);
            error.code = "CACHE_LOCK_LOST";
            throw error;
          }
          const owner = {
            async assertOwned() {
              const current = await lockSnapshot(lockPath);
              if (!sameLock(current, ownerIdentity)) {
                const error = new Error(`cache lock ownership was lost: ${path.basename(lockPath)}`);
                error.code = "CACHE_LOCK_LOST";
                throw error;
              }
            },
            async release() {
              lockClearInterval(heartbeat);
              await handle.close().catch(() => {});
              await removeLockIfToken(lockPath, token).catch(() => {});
            },
          };
          ownershipTransferred = true;
          return owner;
        } finally {
          if (!ownershipTransferred) {
            if (heartbeat !== null) lockClearInterval(heartbeat);
            await handle.close().catch(() => {});
            try {
              const current = await lockSnapshot(lockPath);
              if (openedIdentity && sameFileIdentity(current, openedIdentity)) {
                await rm(lockPath, { force: true });
              }
            } catch {
              // Failed acquisition cleanup is best-effort and identity guarded.
            }
          }
        }
      }

      const completed = await winnerCheck?.();
      if (completed) return { winner: completed };
      if (Date.now() >= deadline) {
        const error = new Error(`cache lock timed out: ${path.basename(lockPath)}`);
        error.code = "CACHE_LOCK_TIMEOUT";
        throw error;
      }
      const observed = await lockSnapshot(lockPath);
      if (!observed) continue;
      if (Date.now() - observed.mtimeMs > staleLock) {
        await recoverStaleLock(lockPath, observed);
        continue;
      }
      await pause(lockPoll);
    }
  }

  async function acquirePublicationLock(hash) {
    const entryRoot = path.join(namespaceRoot, hash);
    return acquireExclusiveLock(
      path.join(namespaceRoot, `.${hash}.lock`),
      () => readValidEntry(entryRoot, hash),
    );
  }

  async function createAndPublish({ hash, keyPayload, version, extension, create }) {
    await mkdir(namespaceRoot, { recursive: true });
    const acquired = await acquirePublicationLock(hash);
    if (acquired.winner) return acquired.winner.paths;

    const entryRoot = path.join(namespaceRoot, hash);
    try {
      const winner = await readValidEntry(entryRoot, hash);
      if (winner) return winner.paths;
      await rm(entryRoot, { recursive: true, force: true });
      const stagingRoot = path.join(namespaceRoot, `.staging-${hash}-${randomUUID()}`);
      await mkdir(stagingRoot, { recursive: false });
      try {
        const firstOutput = path.join(stagingRoot, `${hash}-1${extension}`);
        const created = await create({
          outputPaths: [firstOutput], stagingRoot, hash, extension, keyPayload, version,
        });
        const discovered = await discoverOutputs(stagingRoot, hash, extension);
        const paths = normalizeCreatedPaths(created, discovered)
          .map((item) => path.resolve(String(item)))
          .sort((left, right) => outputOrder(left, right, hash, extension));
        if (paths.length === 0) throw new Error("cache creator produced no non-empty output files");

        const files = [];
        const unique = new Set();
        let totalBytes = 0;
        for (const candidate of paths) {
          if (!isInside(stagingRoot, candidate)) {
            throw new Error("cache creator output must remain inside the staging directory");
          }
          const name = path.basename(candidate);
          if (unique.has(name)) throw new Error(`cache creator returned duplicate output: ${name}`);
          unique.add(name);
          const details = await regularNonempty(candidate);
          if (!details) throw new Error(`cache output must be a regular non-empty file: ${name}`);
          files.push({ name, size: details.size });
          totalBytes += details.size;
        }
        if (totalBytes > byteLimit) {
          throw new Error(`cache entry exceeds maxBytes (${totalBytes} > ${byteLimit})`);
        }

        const timestamp = nowMilliseconds(now);
        await writeFile(path.join(stagingRoot, MANIFEST_NAME), `${JSON.stringify({
          manifestVersion: MANIFEST_VERSION,
          hash,
          version,
          createdAt: timestamp,
          accessedAt: timestamp,
          files,
        })}\n`, { encoding: "utf8", flag: "wx" });
        await acquired.assertOwned();
        await rename(stagingRoot, entryRoot);
        await touchEntry(entryRoot);
        await scheduleEviction();
        return files.map((item) => path.join(entryRoot, item.name));
      } finally {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    } finally {
      await acquired.release();
    }
  }

  async function getOrCreate({ keyPayload, version, extension, create } = {}) {
    if (typeof create !== "function") throw new TypeError("create must be a function");
    const normalizedExtension = normalizeExtension(extension);
    if (version === undefined) throw new TypeError("version is required");
    const hash = contentHash(keyPayload, version);
    const requestLease = await beginRequest(hash);
    let succeeded = false;
    try {
      await mkdir(namespaceRoot, { recursive: true });
      const hit = await validHit(hash);
      if (hit) {
        succeeded = true;
        return hit;
      }

      const active = flights.get(hash);
      if (active) {
        const result = await active;
        succeeded = true;
        return result;
      }
      const pending = createAndPublish({
        hash, keyPayload, version, extension: normalizedExtension, create,
      });
      flights.set(hash, pending);
      try {
        const result = await pending;
        succeeded = true;
        return result;
      } finally {
        if (flights.get(hash) === pending) flights.delete(hash);
      }
    } finally {
      finishRequest(hash, requestLease, succeeded);
    }
  }

  function validateCopySource(source) {
    const sourcePath = path.resolve(String(source));
    const sourceDetails = lstatSync(sourcePath);
    if (sourceDetails.isSymbolicLink()) throw new Error("cached source must not be a symbolic link");
    if (!sourceDetails.isFile() || sourceDetails.size <= 0) {
      throw new Error(`cached source must be a regular non-empty file: ${source}`);
    }
    const namespaceReal = realpathSync(namespaceRoot);
    const sourceReal = realpathSync(sourcePath);
    if (!isInside(namespaceReal, sourceReal)) throw new Error("cached source is outside the cache namespace");
    const parts = path.relative(namespaceReal, sourceReal).split(path.sep);
    if (parts.length !== 2 || !HASH_PATTERN.test(parts[0])) {
      throw new Error("cached source is not inside a hash entry");
    }
    const entryRoot = path.join(namespaceReal, parts[0]);
    const entryDetails = lstatSync(entryRoot);
    if (entryDetails.isSymbolicLink() || !entryDetails.isDirectory()) {
      throw new Error("cache hash entry must be a real directory");
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path.join(entryRoot, MANIFEST_NAME), "utf8"));
    } catch {
      throw new Error("cache manifest is missing or invalid");
    }
    const member = manifest?.manifestVersion === MANIFEST_VERSION
      && manifest?.hash === parts[0]
      && Array.isArray(manifest.files)
      && manifest.files.find((item) => item?.name === parts[1]);
    if (!member) throw new Error("cached source is not a member of the cache manifest");
    if (member.size !== sourceDetails.size) throw new Error("cached source size does not match its manifest");
    return sourceReal;
  }

  function copyForUse(paths, { targetRoot } = {}) {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new TypeError("paths must be a non-empty array");
    }
    if (!targetRoot) throw new TypeError("targetRoot is required");
    const resolvedTarget = path.resolve(String(targetRoot));
    mkdirSync(resolvedTarget, { recursive: true });
    const copiedHashes = new Set();
    const copied = paths.map((source) => {
      const verifiedSource = validateCopySource(source);
      copiedHashes.add(path.basename(path.dirname(verifiedSource)));
      const target = path.join(resolvedTarget, `${randomUUID()}${path.extname(verifiedSource)}`);
      copyFileSync(verifiedSource, target);
      return target;
    });
    for (const hash of copiedHashes) releaseOneLease(hash);
    return copied;
  }

  return Object.freeze({ getOrCreate, copyForUse });
}
