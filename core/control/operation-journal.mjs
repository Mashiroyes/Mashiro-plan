import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { applyControlMigrations, openControlDatabase } from "./database.mjs";

const TRANSITIONS = Object.freeze({ prepared: new Set(["applying", "reverted", "failed"]), applying: new Set(["applied", "reverted", "conflict", "failed"]), applied: new Set(["reverting", "conflict"]), reverting: new Set(["reverted", "conflict", "failed"]), conflict: new Set(["reverting", "reverted", "failed"]), failed: new Set(["applying", "reverting"]), reverted: new Set() });

function hashFile(file) { const hash = createHash("sha256"); hash.update(fs.readFileSync(file)); return hash.digest("hex"); }
function map(row) { return row ? { operationId: row.operation_id, owner: row.owner, kind: row.kind, targetKey: row.target_key, sourcePath: row.source_path, destinationPath: row.destination_path, expectedSha256: row.expected_sha256, ruleId: row.rule_id, state: row.state, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at } : null; }

export function createOperationJournal(sqlitePath, { now = () => new Date() } = {}) {
  const withDb = (callback) => { const db = openControlDatabase(sqlitePath); try { applyControlMigrations(db); return callback(db); } finally { db.close(); } };
  return Object.freeze({
    prepare(input) {
      const at = new Date(now()).toISOString();
      const operationId = input.operationId ?? randomUUID();
      return withDb((db) => { db.prepare(`INSERT INTO operation_journal(operation_id,owner,kind,target_key,source_path,destination_path,expected_sha256,rule_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'prepared',?,?)`).run(operationId, input.owner, input.kind, input.targetKey, input.sourcePath ?? null, input.destinationPath ?? null, input.expectedSha256 ?? null, input.ruleId ?? null, at, at); return map(db.prepare("SELECT * FROM operation_journal WHERE operation_id=?").get(operationId)); });
    },
    transition(operationId, state, { error = null } = {}) {
      return withDb((db) => { const row = db.prepare("SELECT * FROM operation_journal WHERE operation_id=?").get(operationId); if (!row) throw new Error("operation not found"); if (!TRANSITIONS[row.state]?.has(state)) throw new Error(`invalid operation transition: ${row.state} -> ${state}`); db.prepare("UPDATE operation_journal SET state=?,error=?,updated_at=? WHERE operation_id=?").run(state, error ? String(error).slice(0, 500) : null, new Date(now()).toISOString(), operationId); return map(db.prepare("SELECT * FROM operation_journal WHERE operation_id=?").get(operationId)); });
    },
    listOpen(owner = null) { return withDb((db) => (owner ? db.prepare("SELECT * FROM operation_journal WHERE owner=? AND state NOT IN ('reverted','failed') ORDER BY created_at").all(owner) : db.prepare("SELECT * FROM operation_journal WHERE state NOT IN ('reverted','failed') ORDER BY created_at").all()).map(map)); },
    inspectMove(operation) {
      const sourceExists = Boolean(operation.sourcePath && fs.existsSync(operation.sourcePath));
      const destinationExists = Boolean(operation.destinationPath && fs.existsSync(operation.destinationPath));
      const sourceValid = sourceExists && (!operation.expectedSha256 || hashFile(operation.sourcePath) === operation.expectedSha256);
      const destinationValid = destinationExists && (!operation.expectedSha256 || hashFile(operation.destinationPath) === operation.expectedSha256);
      if (sourceExists && destinationExists) return { resolution: "conflict", sourceExists, destinationExists, sourceValid, destinationValid };
      if (!sourceExists && destinationValid) return { resolution: "applied", sourceExists, destinationExists, sourceValid, destinationValid };
      if (sourceValid && !destinationExists) return { resolution: "reverted", sourceExists, destinationExists, sourceValid, destinationValid };
      return { resolution: "failed", sourceExists, destinationExists, sourceValid, destinationValid };
    },
  });
}
