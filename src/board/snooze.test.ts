import assert from "node:assert/strict";
import { test } from "node:test";
import { zonedToUtc } from "../time.ts";
import { snoozePresets } from "./snooze.ts";

const LA = "America/Los_Angeles";

test("tomorrow morning is 9:00 the next day and next week is Monday at 9:00, in the owner's timezone", () => {
  // Thursday 2026-11-19, 3:00 PM in Los Angeles.
  const now = zonedToUtc("2026-11-19T15:00", LA);
  const presets = snoozePresets(now, LA);
  assert.equal(presets.tomorrow, "2026-11-20T09:00");
  assert.equal(presets.nextWeek, "2026-11-23T09:00");
});

test("on a Monday, next week is the Monday after, not today", () => {
  const presets = snoozePresets(zonedToUtc("2026-11-23T08:00", LA), LA);
  assert.equal(presets.nextWeek, "2026-11-30T09:00");
  assert.equal(presets.tomorrow, "2026-11-24T09:00");
});

test("on a Sunday, next week is the next day", () => {
  assert.equal(snoozePresets(zonedToUtc("2026-11-22T20:00", LA), LA).nextWeek, "2026-11-23T09:00");
});

test("the owner's date decides the day, not UTC's: late evening in Los Angeles is already tomorrow in UTC", () => {
  // 11:30 PM on Thursday in Los Angeles is Friday in UTC.
  const presets = snoozePresets(zonedToUtc("2026-11-19T23:30", LA), LA);
  assert.equal(presets.tomorrow, "2026-11-20T09:00");
});

test("across the clocks going back (1 November 2026), tomorrow morning is still 9:00 local, 17:00 UTC", () => {
  const presets = snoozePresets(zonedToUtc("2026-10-31T20:00", LA), LA);
  assert.equal(presets.tomorrow, "2026-11-01T09:00");
  assert.equal(zonedToUtc(presets.tomorrow, LA).toISOString(), "2026-11-01T17:00:00.000Z");
  // The day before was still on summer time: 9:00 was 16:00 UTC.
  assert.equal(zonedToUtc("2026-10-31T09:00", LA).toISOString(), "2026-10-31T16:00:00.000Z");
});

test("across the clocks going forward (8 March 2026), next week's Monday 9:00 is 16:00 UTC", () => {
  // Thursday 5 March, on winter time.
  const presets = snoozePresets(zonedToUtc("2026-03-05T10:00", LA), LA);
  assert.equal(presets.nextWeek, "2026-03-09T09:00");
  assert.equal(zonedToUtc(presets.nextWeek, LA).toISOString(), "2026-03-09T16:00:00.000Z");
});

test("another timezone: Tokyo has no clock changes, and its date is ahead of Los Angeles", () => {
  const now = new Date("2026-11-19T20:00:00.000Z"); // Friday 5:00 AM in Tokyo.
  assert.deepEqual(snoozePresets(now, "Asia/Tokyo"), { tomorrow: "2026-11-21T09:00", nextWeek: "2026-11-23T09:00" });
});
