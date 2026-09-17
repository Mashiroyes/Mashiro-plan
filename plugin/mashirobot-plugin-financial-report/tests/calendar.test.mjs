import assert from "node:assert/strict";
import test from "node:test";

import { getFinancialReportSlot, getProspectusSlot } from "../core/calendar.mjs";

const base = { installedDate: "2026-08-09", pauseIntervals: [] };
const atShanghai = (text) => new Date(`${text}+08:00`);

test("financial report starts next day and respects the 12:20 boundary", () => {
  assert.deepEqual(getFinancialReportSlot(base, atShanghai("2026-08-10T12:19:00")), {
    eligible: false, lessonNumber: 1, localDate: "2026-08-10", scheduledTime: "12:20", reason: "not_due",
  });
  assert.equal(getFinancialReportSlot(base, atShanghai("2026-08-10T12:20:00")).eligible, true);
  assert.equal(getFinancialReportSlot(base, atShanghai("2026-08-11T12:20:00")).lessonNumber, 2);
});

test("financial report skips missed days instead of delivering yesterday after midnight", () => {
  const result = getFinancialReportSlot(base, atShanghai("2026-08-12T00:01:00"));
  assert.equal(result.lessonNumber, 3);
  assert.equal(result.reason, "not_due");
  assert.equal(result.localDate, "2026-08-12");
});

test("pause freezes both natural-day and Tuesday/Friday counters", () => {
  const state = { ...base, pauseIntervals: [{ startDate: "2026-08-11", endDate: "2026-08-14" }] };
  assert.equal(getFinancialReportSlot(state, atShanghai("2026-08-11T12:20:00")).reason, "paused");
  assert.equal(getFinancialReportSlot(state, atShanghai("2026-08-15T12:20:00")).lessonNumber, 2);
  assert.equal(getProspectusSlot(state, atShanghai("2026-08-11T18:10:00")).reason, "paused");
  assert.equal(getProspectusSlot(state, atShanghai("2026-08-18T18:10:00")).lessonNumber, 1);
});

test("prospectus runs only Tuesday and Friday at 18:10", () => {
  const cases = [
    ["2026-08-10T18:10:00", "wrong_day", null],
    ["2026-08-11T18:09:00", "not_due", 1],
    ["2026-08-11T18:10:00", "due", 1],
    ["2026-08-14T18:10:00", "due", 2],
    ["2026-08-15T18:10:00", "wrong_day", null],
  ];
  for (const [date, reason, lesson] of cases) {
    const result = getProspectusSlot(base, atShanghai(date));
    assert.equal(result.reason, reason, date);
    assert.equal(result.lessonNumber, lesson, date);
  }
});

test("course limits are inclusive and then complete", () => {
  assert.equal(getFinancialReportSlot(base, atShanghai("2026-09-08T12:20:00")).lessonNumber, 30);
  assert.equal(getFinancialReportSlot(base, atShanghai("2026-09-09T12:20:00")).reason, "complete");
  assert.equal(getProspectusSlot(base, atShanghai("2026-09-04T18:10:00")).lessonNumber, 8);
  assert.equal(getProspectusSlot(base, atShanghai("2026-09-08T18:10:00")).reason, "complete");
});

test("Shanghai date is independent of host locale", () => {
  const result = getFinancialReportSlot(base, new Date("2026-08-10T04:20:00Z"));
  assert.equal(result.localDate, "2026-08-10");
  assert.equal(result.eligible, true);
});
