#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { createAuditStore } from "../core/audit-storage.mjs";

function decode(value) {
  return JSON.parse(Buffer.from(String(value), "base64").toString("utf8"));
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const [command, sqlitePath, payload64] = process.argv.slice(2);
if (!command || !sqlitePath) throw new Error("Usage: audit-db-v1.mjs <command> <sqlitePath> [payload64]");
const store = createAuditStore(sqlitePath);

switch (command) {
  case "targets64":
    output(store.replaceTargets(decode(payload64)));
    break;
  case "append64":
    output(store.appendBatch(decode(payload64)));
    break;
  case "heartbeat64":
    output(store.heartbeat(decode(payload64)));
    break;
  case "close-stale":
    output(store.closeStaleInterval(payload64 || "interactive"));
    break;
  case "health":
    output(store.workerHealth(new Date()));
    break;
  default:
    throw new Error(`Unknown audit DB command: ${command}`);
}
