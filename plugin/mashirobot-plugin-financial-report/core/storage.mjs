import { DatabaseSync } from "node:sqlite";

const COURSE_TYPES = ["financial_report", "prospectus"];
const TEN_MINUTES = 10 * 60 * 1000;

function assertCourseType(courseType) {
  if (!COURSE_TYPES.includes(courseType)) throw new TypeError(`未知课程类型: ${courseType}`);
}

function previousDate(date) {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function parseState(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    conversationId: row.conversation_id,
    courseType: row.course_type,
    installedDate: row.installed_date,
    paused: Boolean(row.paused),
    currentPauseStart: row.current_pause_start,
    pauseIntervals: JSON.parse(row.pause_intervals_json || "[]"),
    completedAt: row.completed_at,
  };
}

function transaction(database, callback) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function createLearningStore(sqlitePath, options = {}) {
  const database = options.database ?? new DatabaseSync(sqlitePath);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");

  function initialize({ accountId, conversationId, installedDate }) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS financial_report_course_state (
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        course_type TEXT NOT NULL CHECK(course_type IN ('financial_report','prospectus')),
        installed_date TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        current_pause_start TEXT,
        pause_intervals_json TEXT NOT NULL DEFAULT '[]',
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(account_id, conversation_id, course_type)
      );
      CREATE TABLE IF NOT EXISTS financial_report_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        course_type TEXT NOT NULL,
        lesson_number INTEGER NOT NULL,
        scheduled_date TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','missed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        claimed_at TEXT,
        sent_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(account_id, conversation_id, course_type, lesson_number, scheduled_date)
      );
      CREATE INDEX IF NOT EXISTS financial_report_deliveries_lookup
        ON financial_report_deliveries(account_id, conversation_id, course_type, status, scheduled_date);
      CREATE TABLE IF NOT EXISTS financial_report_answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        course_type TEXT NOT NULL,
        lesson_number INTEGER NOT NULL,
        answer_text TEXT NOT NULL,
        submitted_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS financial_report_answers_lookup
        ON financial_report_answers(account_id, conversation_id, course_type, lesson_number, submitted_at);
      CREATE TABLE IF NOT EXISTS financial_report_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        answer_id INTEGER NOT NULL UNIQUE REFERENCES financial_report_answers(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('pending','processing','ready','sent','failed')),
        output_text TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        claimed_at TEXT,
        sent_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS financial_report_feedback_pending
        ON financial_report_feedback(status, claimed_at, id);
    `);
    const now = new Date().toISOString();
    const insert = database.prepare(`
      INSERT OR IGNORE INTO financial_report_course_state
        (account_id, conversation_id, course_type, installed_date, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    return transaction(database, () => {
      for (const courseType of COURSE_TYPES) insert.run(accountId, conversationId, courseType, installedDate, now);
      return COURSE_TYPES.map((courseType) => getCourseState(accountId, conversationId, courseType));
    });
  }

  function getCourseState(accountId, conversationId, courseType) {
    assertCourseType(courseType);
    return parseState(database.prepare(`
      SELECT * FROM financial_report_course_state
      WHERE account_id = ? AND conversation_id = ? AND course_type = ?
    `).get(accountId, conversationId, courseType));
  }

  function pauseCourses(accountId, conversationId, localDate) {
    return transaction(database, () => {
      const now = new Date().toISOString();
      database.prepare(`
        UPDATE financial_report_course_state
        SET paused = 1, current_pause_start = COALESCE(current_pause_start, ?), updated_at = ?
        WHERE account_id = ? AND conversation_id = ?
      `).run(localDate, now, accountId, conversationId);
      return COURSE_TYPES.map((type) => getCourseState(accountId, conversationId, type));
    });
  }

  function resumeCourses(accountId, conversationId, localDate) {
    return transaction(database, () => {
      const rows = COURSE_TYPES.map((type) => getCourseState(accountId, conversationId, type));
      const update = database.prepare(`
        UPDATE financial_report_course_state
        SET paused = 0, current_pause_start = NULL, pause_intervals_json = ?, updated_at = ?
        WHERE account_id = ? AND conversation_id = ? AND course_type = ?
      `);
      const now = new Date().toISOString();
      for (const state of rows) {
        if (!state?.paused || !state.currentPauseStart) continue;
        const intervals = [...state.pauseIntervals, { startDate: state.currentPauseStart, endDate: previousDate(localDate) }]
          .filter((item) => item.endDate >= item.startDate);
        update.run(JSON.stringify(intervals), now, accountId, conversationId, state.courseType);
      }
      return COURSE_TYPES.map((type) => getCourseState(accountId, conversationId, type));
    });
  }

  function claimDelivery({ accountId, conversationId, courseType, lessonNumber, scheduledDate, now = new Date() }) {
    assertCourseType(courseType);
    return transaction(database, () => {
      const timestamp = now.toISOString();
      database.prepare(`
        INSERT OR IGNORE INTO financial_report_deliveries
          (account_id, conversation_id, course_type, lesson_number, scheduled_date, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(accountId, conversationId, courseType, lessonNumber, scheduledDate, timestamp, timestamp);
      const row = database.prepare(`
        SELECT * FROM financial_report_deliveries
        WHERE account_id = ? AND conversation_id = ? AND course_type = ? AND lesson_number = ? AND scheduled_date = ?
      `).get(accountId, conversationId, courseType, lessonNumber, scheduledDate);
      if (row.status === "sent") return { claimed: false, reason: "already_sent", delivery: row };
      if (row.status === "sending" && row.claimed_at && now.getTime() - Date.parse(row.claimed_at) < TEN_MINUTES) {
        return { claimed: false, reason: "busy", delivery: row };
      }
      const staleNote = row.status === "sending" ? "previous worker claim became stale" : row.last_error;
      database.prepare(`
        UPDATE financial_report_deliveries
        SET status = 'sending', attempt_count = attempt_count + 1, claimed_at = ?, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(timestamp, staleNote, timestamp, row.id);
      return { claimed: true, reason: row.status === "sending" ? "reclaimed" : "claimed",
        delivery: database.prepare("SELECT * FROM financial_report_deliveries WHERE id = ?").get(row.id) };
    });
  }

  function finishDelivery(deliveryId, { success, error = null, now = new Date() }) {
    const status = success ? "sent" : "failed";
    const timestamp = now.toISOString();
    database.prepare(`
      UPDATE financial_report_deliveries
      SET status = ?, sent_at = CASE WHEN ? = 1 THEN ? ELSE sent_at END, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(status, success ? 1 : 0, timestamp, error, timestamp, deliveryId);
    return database.prepare("SELECT * FROM financial_report_deliveries WHERE id = ?").get(deliveryId);
  }

  function listProgress(accountId, conversationId) {
    const states = database.prepare(`SELECT * FROM financial_report_course_state WHERE account_id = ? AND conversation_id = ? ORDER BY course_type`)
      .all(accountId, conversationId).map(parseState);
    const counts = database.prepare(`
      SELECT course_type, status, COUNT(*) AS count FROM financial_report_deliveries
      WHERE account_id = ? AND conversation_id = ? GROUP BY course_type, status
    `).all(accountId, conversationId);
    const answers = database.prepare(`
      SELECT course_type, COUNT(*) AS count FROM financial_report_answers
      WHERE account_id = ? AND conversation_id = ? GROUP BY course_type
    `).all(accountId, conversationId);
    return { states, deliveryCounts: counts, answerCounts: answers };
  }

  function markCourseComplete(accountId, conversationId, courseType, now = new Date()) {
    assertCourseType(courseType);
    database.prepare(`
      UPDATE financial_report_course_state SET completed_at = COALESCE(completed_at, ?), updated_at = ?
      WHERE account_id = ? AND conversation_id = ? AND course_type = ?
    `).run(now.toISOString(), now.toISOString(), accountId, conversationId, courseType);
    return getCourseState(accountId, conversationId, courseType);
  }

  function saveAnswer({ accountId, conversationId, courseType, lessonNumber, answerText, now = new Date() }) {
    assertCourseType(courseType);
    if (!answerText?.trim()) throw new TypeError("answerText 不能为空");
    return transaction(database, () => {
      const timestamp = now.toISOString();
      const answer = database.prepare(`
        INSERT INTO financial_report_answers
          (account_id, conversation_id, course_type, lesson_number, answer_text, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(accountId, conversationId, courseType, lessonNumber, answerText.trim(), timestamp);
      database.prepare(`
        INSERT INTO financial_report_feedback(answer_id, status, created_at, updated_at)
        VALUES (?, 'pending', ?, ?)
      `).run(answer.lastInsertRowid, timestamp, timestamp);
      return database.prepare("SELECT * FROM financial_report_answers WHERE id = ?").get(answer.lastInsertRowid);
    });
  }

  function findUnansweredLessons(accountId, conversationId, courseType) {
    assertCourseType(courseType);
    return database.prepare(`
      SELECT d.lesson_number, d.scheduled_date, d.sent_at
      FROM financial_report_deliveries d
      WHERE d.account_id = ? AND d.conversation_id = ? AND d.course_type = ? AND d.status = 'sent'
        AND NOT EXISTS (
          SELECT 1 FROM financial_report_answers a
          WHERE a.account_id = d.account_id AND a.conversation_id = d.conversation_id
            AND a.course_type = d.course_type AND a.lesson_number = d.lesson_number
        )
      ORDER BY d.sent_at DESC, d.id DESC
    `).all(accountId, conversationId, courseType);
  }

  function claimPendingFeedback({ now = new Date() } = {}) {
    return transaction(database, () => {
      const threshold = new Date(now.getTime() - TEN_MINUTES).toISOString();
      const row = database.prepare(`
        SELECT f.*, a.account_id, a.conversation_id, a.course_type, a.lesson_number, a.answer_text
        FROM financial_report_feedback f JOIN financial_report_answers a ON a.id = f.answer_id
        WHERE f.status IN ('pending','failed') OR (f.status = 'processing' AND f.claimed_at < ?)
        ORDER BY f.id LIMIT 1
      `).get(threshold);
      if (!row) return null;
      const timestamp = now.toISOString();
      const stale = row.status === "processing" ? "previous feedback worker claim became stale" : row.last_error;
      database.prepare(`
        UPDATE financial_report_feedback SET status = 'processing', retry_count = retry_count + 1,
          claimed_at = ?, last_error = ?, updated_at = ? WHERE id = ?
      `).run(timestamp, stale, timestamp, row.id);
      return { ...row, status: "processing", claimed_at: timestamp, last_error: stale };
    });
  }

  function finishFeedback(feedbackId, outputText, { sent = false, now = new Date() } = {}) {
    const timestamp = now.toISOString();
    database.prepare(`
      UPDATE financial_report_feedback SET status = ?, output_text = ?, sent_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(sent ? "sent" : "ready", outputText, sent ? timestamp : null, timestamp, feedbackId);
    return database.prepare("SELECT * FROM financial_report_feedback WHERE id = ?").get(feedbackId);
  }

  function failFeedback(feedbackId, error, { now = new Date() } = {}) {
    const timestamp = now.toISOString();
    database.prepare(`UPDATE financial_report_feedback SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`)
      .run(String(error), timestamp, feedbackId);
    return database.prepare("SELECT * FROM financial_report_feedback WHERE id = ?").get(feedbackId);
  }

  return {
    initialize, getCourseState, pauseCourses, resumeCourses, claimDelivery, finishDelivery,
    listProgress, markCourseComplete, saveAnswer, findUnansweredLessons, claimPendingFeedback, finishFeedback, failFeedback,
    integrityCheck: () => database.prepare("PRAGMA integrity_check").get().integrity_check,
    close: () => database.close(),
    _database: database,
  };
}
