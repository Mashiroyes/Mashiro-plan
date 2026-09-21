import test from "node:test";
import assert from "node:assert/strict";
import { evaluateReleaseQuota } from "../core/release-quota.mjs";

const at = (local) => new Date(`${local.replace(" ", "T")}:00+08:00`);

test("applies the three Shanghai period limits", () => {
  for (const [start, minutes, limit] of [
    ["2026-09-22 09:00", 20, 20],
    ["2026-09-22 13:00", 30, 30],
    ["2026-09-22 19:00", 30, 30],
  ]) {
    const from = at(start);
    const result = evaluateReleaseQuota({ intervals: [], proposedStart: from, proposedEnd: new Date(from.getTime() + minutes * 60_000) });
    assert.equal(result.allowed, true);
    assert.equal(result.periods[0].limitMinutes, limit);
    assert.equal(result.periods[0].remainingMinutes, 0);
  }
});

test("merges overlap instead of charging it twice", () => {
  const result = evaluateReleaseQuota({
    intervals: [{ startAt: at("2026-09-22 09:00"), endAt: at("2026-09-22 09:10") }],
    proposedStart: at("2026-09-22 09:05"),
    proposedEnd: at("2026-09-22 09:15"),
  });
  assert.equal(result.allowed, true);
  assert.equal(result.periods[0].usedMinutes, 10);
  assert.equal(result.periods[0].addedMinutes, 5);
  assert.equal(result.periods[0].remainingMinutes, 5);
});

test("splits requests at noon, 18:00, and midnight", () => {
  for (const [start, end, expected] of [
    ["2026-09-22 11:50", "2026-09-22 12:10", [20, 30]],
    ["2026-09-22 17:50", "2026-09-22 18:10", [30, 30]],
    ["2026-09-22 23:50", "2026-09-23 00:10", [30, 20]],
  ]) {
    const result = evaluateReleaseQuota({ intervals: [], proposedStart: at(start), proposedEnd: at(end) });
    assert.deepEqual(result.periods.map((period) => period.limitMinutes), expected);
    assert.deepEqual(result.periods.map((period) => period.addedMinutes), [10, 10]);
  }
});

test("rejects the whole proposal if one touched period is exhausted", () => {
  const result = evaluateReleaseQuota({
    intervals: [{ startAt: at("2026-09-22 11:30"), endAt: at("2026-09-22 11:50") }],
    proposedStart: at("2026-09-22 11:55"),
    proposedEnd: at("2026-09-22 12:05"),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.periods[0].remainingMinutes, -5);
  assert.equal(result.periods[1].remainingMinutes, 25);
});

