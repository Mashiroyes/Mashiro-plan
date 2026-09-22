#!/usr/bin/env node
import path from "node:path";
import { createRotatingBackup } from "./backup-manager.mjs";

const [, , sqlitePath, backupRoot = path.join(path.dirname(path.resolve(sqlitePath ?? "")), "backups"), reason = "manual"] = process.argv;
if (!sqlitePath) throw new Error("usage: backup-cli.mjs <sqlite-path> [backup-root] [reason]");
process.stdout.write(`${JSON.stringify(createRotatingBackup({ sqlitePath, backupRoot, reason }))}\n`);
