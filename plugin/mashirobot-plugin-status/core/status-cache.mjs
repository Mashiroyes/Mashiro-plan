import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const KINDS = new Set(["status", "hardware"]);

function milliseconds(value) {
  const resolved = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(resolved)) throw new TypeError("now must resolve to a valid time");
  return resolved;
}

export function createStatusCache({
  root,
  statusTtlMs = 5_000,
  hardwareTtlMs = 86_400_000,
  now = Date.now,
} = {}) {
  if (!root) throw new TypeError("root is required");
  const cacheRoot = path.resolve(String(root));
  const ttl = { status: Number(statusTtlMs), hardware: Number(hardwareTtlMs) };
  for (const [kind, value] of Object.entries(ttl)) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`${kind} TTL must be nonnegative`);
  }

  function fileFor(kind) {
    if (!KINDS.has(kind)) throw new TypeError(`unknown status cache kind: ${kind}`);
    return path.join(cacheRoot, `${kind}.json`);
  }

  function currentTime() {
    return milliseconds(typeof now === "function" ? now() : now);
  }

  async function read(kind) {
    let stored;
    try {
      stored = JSON.parse(await readFile(fileFor(kind), "utf8"));
    } catch {
      return null;
    }
    const capturedMs = Date.parse(stored?.capturedAt);
    const writtenMs = Date.parse(stored?.writtenAt);
    const current = currentTime();
    if (!stored?.data || !Number.isFinite(capturedMs) || !Number.isFinite(writtenMs)) return null;
    if (capturedMs > current + 1_000 || writtenMs > current + 1_000) return null;
    const ageMs = Math.max(0, current - capturedMs);
    return { fresh: ageMs <= ttl[kind], ageMs, capturedAt: stored.capturedAt, data: stored.data };
  }

  async function write(kind, data) {
    const target = fileFor(kind);
    const current = currentTime();
    const parsedCaptured = Date.parse(data?.capturedAt);
    const capturedAt = Number.isFinite(parsedCaptured) && parsedCaptured <= current + 1_000
      ? new Date(parsedCaptured).toISOString()
      : new Date(current).toISOString();
    const payload = {
      capturedAt,
      writtenAt: new Date(current).toISOString(),
      data,
    };
    await mkdir(cacheRoot, { recursive: true });
    const temporary = path.join(cacheRoot, `.${kind}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return payload;
  }

  return Object.freeze({ read, write });
}
