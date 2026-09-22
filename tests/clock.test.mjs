import assert from "node:assert/strict";
import test from "node:test";
import { createClock } from "../core/time/clock.mjs";

for (const [instant, date, sleepDate] of [
  ["2026-09-22T21:59:59.000Z", "2026-09-23", "2026-09-22"],
  ["2026-09-22T22:00:00.000Z", "2026-09-23", "2026-09-23"],
  ["2026-12-31T16:00:00.000Z", "2027-01-01", "2026-12-31"],
  ["2026-01-31T16:00:00.000Z", "2026-02-01", "2026-01-31"],
]) {
  test(`preserves Shanghai and 06:00 business dates at ${instant}`, () => {
    const clock = createClock({ now: () => new Date(instant) });
    assert.equal(clock.shanghaiDate(), date);
    assert.equal(clock.sleepBusinessDate(), sleepDate);
  });
}
