#!/usr/bin/env node
import { createJobManager } from "./job-manager.mjs";

function decode(value) { return JSON.parse(Buffer.from(value, "base64").toString("utf8")); }
const [, , action, sqlitePath, payload64] = process.argv;
if (!action || !sqlitePath) throw new Error("usage: job-cli.mjs <action> <sqlite-path> [payload-base64]");
const manager = createJobManager({ sqlitePath });
const payload = payload64 ? decode(payload64) : {};
let result;
if (action === "upsert") result = manager.upsertDesired(payload);
else if (action === "claim") result = manager.claim(payload.jobId, payload.version);
else if (action === "complete") result = manager.complete(payload.jobId, payload.version, payload);
else if (action === "cancel") result = { cancelled: manager.cancel(payload.jobId) };
else if (action === "cancel-task") result = { cancelled: manager.cancelByTaskName(payload.taskName) };
else if (action === "list") result = manager.listDesired();
else if (action === "recover-stale") result = { recovered: manager.recoverStale(payload) };
else throw new Error(`unknown job action: ${action}`);
process.stdout.write(`${JSON.stringify(result)}\n`);
