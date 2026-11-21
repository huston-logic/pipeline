import assert from "node:assert/strict";
import { test } from "node:test";
import { addMonths, isFirstOfMonth, lastMonth, monthBounds, monthLabel, reportMonth } from "./month.ts";

const TZ = "America/Los_Angeles";
// Fri Nov 20, 2026, noon in Los Angeles.
const NOW = new Date("2026-11-20T20:00:00.000Z");

test("addMonths and lastMonth cross year ends", () => {
  assert.equal(addMonths("2026-11", -1), "2026-10");
  assert.equal(addMonths("2026-01", -1), "2025-12");
  assert.equal(addMonths("2026-12", 1), "2027-01");
  assert.equal(addMonths("2026-11", -12), "2025-11");
  assert.equal(lastMonth(NOW, TZ), "2026-10");
  // 5 PM on Dec 31 in Los Angeles is already Jan 1 in UTC: the owner's calendar decides.
  assert.equal(lastMonth(new Date("2027-01-01T01:00:00.000Z"), TZ), "2026-11");
});

test("monthBounds are the owner's midnights, so a late-evening local time stays in its month", () => {
  const { start, end } = monthBounds("2026-11", TZ);
  assert.equal(start.toISOString(), "2026-11-01T07:00:00.000Z");
  assert.equal(end.toISOString(), "2026-12-01T08:00:00.000Z");
  assert.equal(monthBounds("2026-12", "UTC").end.toISOString(), "2027-01-01T00:00:00.000Z");
});

test("monthLabel is the month name and year", () => {
  assert.equal(monthLabel("2026-10"), "October 2026");
  assert.equal(monthLabel("2027-01"), "January 2027");
});

test("reportMonth: default last month; the last 12 finished months are allowed; anything else falls back", () => {
  assert.equal(reportMonth(null, NOW, TZ), "2026-10");
  assert.equal(reportMonth("2026-09", NOW, TZ), "2026-09");
  assert.equal(reportMonth("2025-11", NOW, TZ), "2025-11", "12 months back");
  assert.equal(reportMonth("2025-10", NOW, TZ), "2026-10", "13 months back");
  assert.equal(reportMonth("2026-11", NOW, TZ), "2026-10", "this month is not finished");
  assert.equal(reportMonth("2027-01", NOW, TZ), "2026-10", "the future");
  for (const bad of ["", "2026-13", "2026-00", "2026-9", "26-09", "2026-09-01", "<script>", "2026-09 ", "last"]) {
    assert.equal(reportMonth(bad, NOW, TZ), "2026-10", bad);
  }
});

test("isFirstOfMonth reads a YYYY-MM-DD date", () => {
  assert.equal(isFirstOfMonth("2026-12-01"), true);
  assert.equal(isFirstOfMonth("2026-12-02"), false);
  assert.equal(isFirstOfMonth("2026-12-11"), false);
});
