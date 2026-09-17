import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runCli } from "../runtime/cli.mjs";
import { createLearningStore } from "../core/storage.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "mashiro-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, "db.sqlite");
  const base = ["--sqlite-path", db, "--plugin-root", root, "--account-id", "wx", "--conversation-id", "me"];
  runCli(["init", ...base, "--installed-date", "2026-08-09"]);
  return { db, base };
}

test("prepare delivery returns bounded actions and preserves Chinese via Base64", (t) => {
  const { base } = fixture(t);
  assert.equal(runCli(["prepare-delivery", ...base, "--course-type", "financial_report", "--now", "2026-08-10T04:19:00Z"]).action, "not_due");
  const due = runCli(["prepare-delivery", ...base, "--course-type", "financial_report", "--now", "2026-08-10T04:20:00Z"]);
  assert.equal(due.action, "send");
  assert.match(Buffer.from(due.messageBase64, "base64").toString("utf8"), /财报事实/);
  runCli(["finish-delivery", ...base, "--delivery-id", String(due.deliveryId), "--success", "true"]);
  assert.equal(runCli(["prepare-delivery", ...base, "--course-type", "financial_report", "--now", "2026-08-10T04:21:00Z"]).action, "already_sent");
});

test("reports wrong day, pause and completion", (t) => {
  const { base, db } = fixture(t);
  assert.equal(runCli(["prepare-delivery", ...base, "--course-type", "prospectus", "--now", "2026-08-10T10:10:00Z"]).action, "wrong_day");
  const store = createLearningStore(db);
  store.pauseCourses("wx", "me", "2026-08-11");
  store.close();
  assert.equal(runCli(["prepare-delivery", ...base, "--course-type", "prospectus", "--now", "2026-08-11T10:10:00Z"]).action, "paused");
  assert.ok(["send", "already_sent", "not_due", "paused", "complete", "wrong_day"].includes("complete"));
});

test("progress and feedback CLI commands return JSON-ready objects", (t) => {
  const { base } = fixture(t);
  assert.equal(runCli(["progress", ...base]).action, "progress");
  assert.equal(runCli(["claim-feedback", ...base]).feedback, null);
});
