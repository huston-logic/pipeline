import assert from "node:assert/strict";
import { test } from "node:test";
import { UserError } from "./services/errors.ts";
import {
  addDays,
  dayBoundsUtc,
  DEFAULT_TZ,
  formatLocal,
  localDate,
  localHour,
  parseWhen,
  zonedToUtc,
} from "./time.ts";

const LA = "America/Los_Angeles";
const HOUR = 3_600_000;

test("the default timezone is Los Angeles", () => {
  assert.equal(DEFAULT_TZ, LA);
});

test("zonedToUtc reads owner wall time in standard and daylight time", () => {
  assert.equal(zonedToUtc("2026-11-19T14:00", LA).toISOString(), "2026-11-19T22:00:00.000Z");
  assert.equal(zonedToUtc("2026-10-31T14:00", LA).toISOString(), "2026-10-31T21:00:00.000Z");
  assert.equal(zonedToUtc("2026-11-19", LA).toISOString(), "2026-11-19T08:00:00.000Z");
  assert.equal(zonedToUtc("2026-11-19T14:00", "UTC").toISOString(), "2026-11-19T14:00:00.000Z");
  assert.equal(zonedToUtc("2026-11-19T14:00", "Asia/Kolkata").toISOString(), "2026-11-19T08:30:00.000Z");
});

test("zonedToUtc on the days the clocks change", () => {
  // The afternoon after the fall-back change is standard time again.
  assert.equal(zonedToUtc("2026-11-01T14:00", LA).toISOString(), "2026-11-01T22:00:00.000Z");
  // 01:30 happens twice on 2026-11-01: the first one (daylight time) is used.
  assert.equal(zonedToUtc("2026-11-01T01:30", LA).toISOString(), "2026-11-01T08:30:00.000Z");
  // 02:30 does not exist on 2027-03-14: it moves forward by the skipped hour, to 03:30 daylight time.
  assert.equal(zonedToUtc("2027-03-14T02:30", LA).toISOString(), "2027-03-14T10:30:00.000Z");
  assert.equal(zonedToUtc("2027-03-14T14:00", LA).toISOString(), "2027-03-14T21:00:00.000Z");
});

test("dayBoundsUtc spans 25 hours on fall-back day and 23 on spring-forward day", () => {
  const fall = dayBoundsUtc("2026-11-01", LA);
  assert.equal(fall.start.toISOString(), "2026-11-01T07:00:00.000Z");
  assert.equal(fall.end.toISOString(), "2026-11-02T08:00:00.000Z");
  assert.equal(fall.end.getTime() - fall.start.getTime(), 25 * HOUR);

  const spring = dayBoundsUtc("2027-03-14", LA);
  assert.equal(spring.end.getTime() - spring.start.getTime(), 23 * HOUR);

  const normal = dayBoundsUtc("2026-11-19", LA);
  assert.equal(normal.end.getTime() - normal.start.getTime(), 24 * HOUR);
});

test("localDate and localHour use the owner's timezone", () => {
  assert.equal(localDate(new Date("2026-11-19T07:30:00Z"), LA), "2026-11-18");
  assert.equal(localDate(new Date("2026-11-19T08:00:00Z"), LA), "2026-11-19");
  assert.equal(localHour(new Date("2026-11-19T15:00:00Z"), LA), 7);
  assert.equal(localHour(new Date("2026-11-19T08:00:00Z"), LA), 0);
  // Fall-back day: 07:00 local happens at 15:00Z (after the change), 1 a.m. happens twice.
  assert.equal(localHour(new Date("2026-11-01T15:00:00Z"), LA), 7);
  assert.equal(localHour(new Date("2026-11-01T08:30:00Z"), LA), 1);
  assert.equal(localHour(new Date("2026-11-01T09:30:00Z"), LA), 1);
});

test("addDays is calendar arithmetic across months, years and leap days", () => {
  assert.equal(addDays("2026-11-19", 1), "2026-11-20");
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2026-11-19", 0), "2026-11-19");
});

test("formatLocal shows weekday, date and 12-hour time in the owner's timezone", () => {
  assert.equal(formatLocal(new Date("2026-11-19T22:00:00Z"), LA), "Thu Nov 19, 2:00 PM");
  assert.equal(formatLocal("2026-11-19T22:00:00.000Z", LA), "Thu Nov 19, 2:00 PM");
  assert.equal(formatLocal("2026-11-19T08:05:00.000Z", LA), "Thu Nov 19, 12:05 AM");
  assert.equal(formatLocal("2026-10-31T19:30:00.000Z", LA), "Sat Oct 31, 12:30 PM");
});

test("parseWhen accepts a date, a local date-time, or an ISO time with offset", () => {
  assert.equal(parseWhen("2026-11-19", LA).toISOString(), "2026-11-19T08:00:00.000Z");
  assert.equal(parseWhen("2026-11-19T14:00", LA).toISOString(), "2026-11-19T22:00:00.000Z");
  assert.equal(parseWhen(" 2026-11-19T14:00 ", LA).toISOString(), "2026-11-19T22:00:00.000Z");
  assert.equal(parseWhen("2026-11-19T14:00:30", LA).toISOString(), "2026-11-19T22:00:30.000Z");
  assert.equal(parseWhen("2026-11-19T22:00:00Z", LA).toISOString(), "2026-11-19T22:00:00.000Z");
  assert.equal(parseWhen("2026-11-19T22:00:00.000Z", LA).toISOString(), "2026-11-19T22:00:00.000Z");
  assert.equal(parseWhen("2026-11-19T14:00:00-08:00", LA).toISOString(), "2026-11-19T22:00:00.000Z");
});

test("parseWhen reads a UTC offset, including half- and quarter-hour ones, whatever the owner's timezone", () => {
  for (const tz of [LA, "Asia/Kolkata", "Australia/Adelaide", "Asia/Kathmandu"]) {
    assert.equal(parseWhen("2026-11-19T14:00-08:00", tz).toISOString(), "2026-11-19T22:00:00.000Z", tz);
    assert.equal(parseWhen("2026-11-19T14:00+05:30", tz).toISOString(), "2026-11-19T08:30:00.000Z", tz);
    assert.equal(parseWhen("2026-11-19T14:00:00+05:45", tz).toISOString(), "2026-11-19T08:15:00.000Z", tz);
    assert.equal(parseWhen("2026-11-19T14:00Z", tz).toISOString(), "2026-11-19T14:00:00.000Z", tz);
    // An offset that crosses midnight lands on the UTC day it names.
    assert.equal(parseWhen("2026-11-19T01:00+14:00", tz).toISOString(), "2026-11-18T11:00:00.000Z", tz);
  }
});

test("timezones with half- and quarter-hour offsets: wall time, day bounds and the hour", () => {
  assert.equal(zonedToUtc("2026-11-19T14:00", "Asia/Kathmandu").toISOString(), "2026-11-19T08:15:00.000Z");
  assert.equal(zonedToUtc("2026-11-19T14:00", "Australia/Adelaide").toISOString(), "2026-11-19T03:30:00.000Z");
  assert.equal(parseWhen("2026-11-19", "Asia/Kolkata").toISOString(), "2026-11-18T18:30:00.000Z");

  const kolkata = dayBoundsUtc("2026-11-19", "Asia/Kolkata");
  assert.deepEqual([kolkata.start.toISOString(), kolkata.end.toISOString()], ["2026-11-18T18:30:00.000Z", "2026-11-19T18:30:00.000Z"]);
  // Adelaide (+9:30/+10:30) changes its clocks by an hour; Lord Howe (+10:30/+11) by only 30 minutes.
  const adelaideSpring = dayBoundsUtc("2026-10-04", "Australia/Adelaide");
  assert.equal(adelaideSpring.end.getTime() - adelaideSpring.start.getTime(), 23 * HOUR);
  const adelaideFall = dayBoundsUtc("2026-04-05", "Australia/Adelaide");
  assert.equal(adelaideFall.end.getTime() - adelaideFall.start.getTime(), 25 * HOUR);
  const lordHowe = dayBoundsUtc("2026-10-04", "Australia/Lord_Howe");
  assert.equal(lordHowe.end.getTime() - lordHowe.start.getTime(), 23.5 * HOUR);
  // A skipped time moves forward by the skipped amount; a repeated one is the first.
  assert.equal(zonedToUtc("2026-10-04T02:30", "Australia/Adelaide").toISOString(), "2026-10-03T17:00:00.000Z");
  assert.equal(zonedToUtc("2026-04-05T02:30", "Australia/Adelaide").toISOString(), "2026-04-04T16:00:00.000Z");
  assert.equal(zonedToUtc("2026-10-04T02:15", "Australia/Lord_Howe").toISOString(), "2026-10-03T15:45:00.000Z");
  // A day whose midnight is skipped (Chile) starts at 01:00.
  assert.equal(dayBoundsUtc("2026-09-06", "America/Santiago").start.toISOString(), "2026-09-06T04:00:00.000Z");

  // The hourly run fires on the UTC hour, which is :30 or :45 past in these zones; localHour reports the hour shown.
  assert.equal(localHour(new Date("2026-11-19T03:00:00Z"), "Asia/Kolkata"), 8);
  assert.equal(localHour(new Date("2026-11-19T03:00:00Z"), "Asia/Kathmandu"), 8);
  assert.equal(localHour(new Date("2026-11-19T02:00:00Z"), "Asia/Kathmandu"), 7);
  assert.equal(localHour(new Date("2026-11-19T03:00:00Z"), "Australia/Adelaide"), 13);
});

test("parseWhen refuses anything else with a UserError naming the accepted formats", () => {
  for (const input of ["next tuesday", "", "2026-02-30", "2026-11-19T25:00", "11/19/2026", "2026-11-19T14:00+99:00", "2026-11-19T14:00+0530", "2026-02-30T14:00Z", "2026-11-19T24:00Z"]) {
    assert.throws(
      () => parseWhen(input, LA),
      (error: unknown) => {
        assert.ok(error instanceof UserError, `${input}: not a UserError`);
        assert.equal(error.name, "UserError");
        assert.match(error.message, /YYYY-MM-DD\b/);
        assert.match(error.message, /YYYY-MM-DDTHH:mm/);
        assert.match(error.message, /offset/);
        return true;
      },
      input,
    );
  }
});
