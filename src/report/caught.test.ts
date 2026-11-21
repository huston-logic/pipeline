import assert from "node:assert/strict";
import { test } from "node:test";
import { type CaughtInput, composeCaught, sourceLine } from "./caught.ts";

const TZ = "America/Los_Angeles";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// October 2026 in Los Angeles runs from Oct 1 07:00 UTC to Nov 1 07:00 UTC.
const MADE = "2026-10-10T18:00:00.000Z";
const at = (iso: string, plus = 0) => new Date(Date.parse(iso) + plus).toISOString();

const empty = (): CaughtInput => ({ month: "2026-10", tz: TZ, firings: [], tasks: [], reaches: [], deals: [], leads: [] });
const firing = (n: number, extra: Partial<CaughtInput["firings"][number]> = {}): CaughtInput["firings"][number] => ({
  ruleId: "rl_a",
  dealId: `dl_${n}`,
  contactId: null,
  taskId: `tk_${n}`,
  firedAt: MADE,
  ...extra,
});
const task = (n: number, extra: Partial<CaughtInput["tasks"][number]> = {}): CaughtInput["tasks"][number] => ({
  id: `tk_${n}`,
  doneAt: null,
  createdAt: MADE,
  ...extra,
});
const lead = (n: number, extra: Partial<CaughtInput["leads"][number]> = {}): CaughtInput["leads"][number] => ({
  id: `ct_${n}`,
  source: "Referral",
  sourceOutside: false,
  createdAt: "2026-09-01T00:00:00.000Z",
  leadStatus: "new",
  leadStatusAt: null,
  firstReachAt: null,
  ...extra,
});

test("an empty month has zero counts, no sources and is flagged empty", () => {
  const report = composeCaught(empty());
  assert.equal(report.month, "2026-10");
  assert.deepEqual(
    [report.rulesFired, report.tasksMade, report.actedOn, report.dealsTouched, report.valueTouched, report.bySource.length],
    [0, 0, 0, 0, 0, 0],
  );
  assert.equal(report.empty, true);
});

test("counts every firing, task, acted-on task, distinct deal touched and the value of those deals", () => {
  const report = composeCaught({
    ...empty(),
    firings: [
      firing(1), // task done
      firing(2), // reach on the deal 2 days later
      firing(3), // nothing happened
      firing(4, { ruleId: "rl_b", dealId: "dl_2", taskId: "tk_4" }), // a second nudge on deal 2, also acted on by that reach
      firing(5, { dealId: null, contactId: "ct_9", taskId: "tk_5" }), // a lead nudge, reach on the person
    ],
    tasks: [task(1, { doneAt: at(MADE, 40 * DAY) }), task(2), task(3), task(4), task(5)],
    reaches: [
      { dealId: "dl_2", contactId: null, occurredAt: at(MADE, 2 * DAY) },
      { dealId: null, contactId: "ct_9", occurredAt: at(MADE, DAY) },
      { dealId: "dl_3", contactId: null, occurredAt: at(MADE, -DAY) }, // before the task was made: not a response
    ],
    deals: [
      { id: "dl_1", value: 1000 },
      { id: "dl_2", value: 2500.5 },
      { id: "dl_3", value: 9999 },
      { id: "dl_4", value: null },
    ],
  });
  assert.equal(report.rulesFired, 5);
  assert.equal(report.tasksMade, 5);
  assert.equal(report.actedOn, 4);
  assert.equal(report.dealsTouched, 2, "dl_1 and dl_2; dl_2 once; the lead nudge is not a deal");
  assert.equal(report.valueTouched, 3500.5);
  assert.deepEqual(report.lines, [
    "Rules fired: 5",
    "Tasks made: 5",
    "Acted on within 7 days: 4 of 5",
    "Deals touched after a nudge: 2, worth 3,500.5",
  ]);
});

test("the 7-day edge: a reach 6 days 23 hours after the task counts, 7 days 1 hour after does not", () => {
  const base = { ...empty(), firings: [firing(1), firing(2), firing(3)], tasks: [task(1), task(2), task(3)] };
  const report = composeCaught({
    ...base,
    reaches: [
      { dealId: "dl_1", contactId: null, occurredAt: at(MADE, 6 * DAY + 23 * HOUR) },
      { dealId: "dl_2", contactId: null, occurredAt: at(MADE, 7 * DAY + HOUR) },
      { dealId: "dl_3", contactId: null, occurredAt: at(MADE, 7 * DAY) },
    ],
    deals: [{ id: "dl_1", value: 10 }, { id: "dl_2", value: 20 }, { id: "dl_3", value: 40 }],
  });
  assert.equal(report.actedOn, 2, "dl_1 and, exactly at 7 days, dl_3");
  assert.equal(report.valueTouched, 50);
});

test("a task completed after the 7 days still counts as acted on; one left open does not", () => {
  const report = composeCaught({
    ...empty(),
    firings: [firing(1), firing(2)],
    tasks: [task(1, { doneAt: at(MADE, 30 * DAY) }), task(2)],
  });
  assert.equal(report.actedOn, 1);
});

test("a reach on the same person counts for a deal nudge that carries the person; a reach on another deal does not", () => {
  const report = composeCaught({
    ...empty(),
    firings: [firing(1, { contactId: "ct_1" })],
    tasks: [task(1)],
    reaches: [
      { dealId: "dl_other", contactId: null, occurredAt: at(MADE, DAY) },
      { dealId: null, contactId: "ct_1", occurredAt: at(MADE, DAY) },
    ],
  });
  assert.equal(report.actedOn, 1);
  const none = composeCaught({
    ...empty(),
    firings: [firing(1)],
    tasks: [task(1)],
    reaches: [{ dealId: "dl_other", contactId: "ct_x", occurredAt: at(MADE, DAY) }],
  });
  assert.equal(none.actedOn, 0);
});

test("firings outside the month are ignored, by the owner's calendar", () => {
  const report = composeCaught({
    ...empty(),
    firings: [
      firing(1, { firedAt: "2026-10-01T06:59:59.000Z" }), // Sep 30, 11:59 PM there
      firing(2, { firedAt: "2026-10-01T07:00:00.000Z" }), // first moment of October
      firing(3, { firedAt: "2026-11-01T06:59:59.000Z" }), // last second of October
      firing(4, { firedAt: "2026-11-01T07:00:00.000Z" }), // November
    ],
    tasks: [task(1), task(2), task(3), task(4)],
  });
  assert.equal(report.rulesFired, 2);
  assert.equal(report.tasksMade, 2);
});

test("a firing whose task is gone is a rule fired, not a task made", () => {
  const report = composeCaught({ ...empty(), firings: [firing(1, { taskId: null }), firing(2, { taskId: "tk_missing" })] });
  assert.equal(report.rulesFired, 2);
  assert.equal(report.tasksMade, 0);
  assert.equal(report.actedOn, 0);
});

test("a deal archived or closed later still counts, because it is looked up by id", () => {
  const report = composeCaught({
    ...empty(),
    firings: [firing(1)],
    tasks: [task(1, { doneAt: at(MADE, DAY) })],
    deals: [{ id: "dl_1", value: 800 }],
  });
  assert.equal(report.valueTouched, 800);
});

test("leads: added, contacted (first reach) and qualified are counted in the month, by source", () => {
  const report = composeCaught({
    ...empty(),
    leads: [
      // added in October, contacted in October, qualified in October
      lead(1, { createdAt: "2026-10-02T17:00:00.000Z", firstReachAt: "2026-10-04T17:00:00.000Z", leadStatus: "qualified", leadStatusAt: "2026-10-20T17:00:00.000Z" }),
      // added in September, first reach in October
      lead(2, { firstReachAt: "2026-10-05T17:00:00.000Z", leadStatus: "contacted", leadStatusAt: "2026-10-05T17:00:00.000Z" }),
      // added in October, never reached
      lead(3, { createdAt: "2026-10-06T17:00:00.000Z", source: "Trade show" }),
      // qualified in November: not this month
      lead(4, { createdAt: "2026-10-07T17:00:00.000Z", leadStatus: "qualified", leadStatusAt: "2026-11-02T17:00:00.000Z", firstReachAt: "2026-09-30T17:00:00.000Z" }),
      // nothing in October at all
      lead(5, { firstReachAt: "2026-09-02T17:00:00.000Z", leadStatus: "contacted", leadStatusAt: "2026-09-02T17:00:00.000Z" }),
    ],
  });
  assert.deepEqual(report.bySource, [
    { source: "Referral", outside: false, added: 2, contacted: 2, qualified: 1 },
    { source: "Trade show", outside: false, added: 1, contacted: 0, qualified: 0 },
  ]);
  assert.equal(report.empty, false);
  assert.equal(sourceLine(report.bySource[0]!), "Referral: 2 added, 2 contacted, 1 qualified");
});

test("sources are grouped the way company names are: trimmed, spaces collapsed, case ignored; the earliest trusted spelling is the label", () => {
  const inOct = { createdAt: "2026-10-05T17:00:00.000Z" };
  const report = composeCaught({
    ...empty(),
    leads: [
      lead(1, { ...inOct, source: "  REFERRAL ", sourceOutside: true, createdAt: "2026-10-01T09:00:00.000Z" }),
      lead(2, { ...inOct, source: "referral   program", createdAt: "2026-10-03T09:00:00.000Z" }),
      lead(3, { ...inOct, source: "Referral Program", createdAt: "2026-10-02T09:00:00.000Z" }),
      lead(4, { ...inOct, source: "Referral" }),
    ],
  });
  // "referral": lead 1 is earliest but from outside, so lead 4's spelling is the label. "referral program": lead 3 is earliest.
  assert.deepEqual(
    report.bySource.map((s) => [s.source, s.outside, s.added]),
    [["Referral", false, 2], ["Referral Program", false, 2]],
  );
});

test("a source known only from outside keeps its earliest spelling and is marked outside", () => {
  const report = composeCaught({
    ...empty(),
    leads: [
      lead(1, { source: "Web Form ", sourceOutside: true, createdAt: "2026-10-09T09:00:00.000Z" }),
      lead(2, { source: "web form", sourceOutside: true, createdAt: "2026-10-03T09:00:00.000Z" }),
    ],
  });
  assert.deepEqual(report.bySource, [{ source: "web form", outside: true, added: 2, contacted: 0, qualified: 0 }]);
});

test("no source and a blank source are one group, 'No source', listed last", () => {
  const report = composeCaught({
    ...empty(),
    leads: [
      lead(1, { source: null, createdAt: "2026-10-09T09:00:00.000Z" }),
      lead(2, { source: "   ", createdAt: "2026-10-09T10:00:00.000Z" }),
      lead(3, { source: "Zed", createdAt: "2026-10-09T11:00:00.000Z" }),
    ],
  });
  assert.deepEqual(report.bySource.map((s) => [s.source, s.added]), [["Zed", 1], ["No source", 2]]);
});

test("a month with only lead activity is not empty", () => {
  const report = composeCaught({ ...empty(), leads: [lead(1, { createdAt: "2026-10-09T09:00:00.000Z" })] });
  assert.equal(report.rulesFired, 0);
  assert.equal(report.empty, false);
});

test("compose does not change its input", () => {
  const input = { ...empty(), firings: [firing(1)], tasks: [task(1)], leads: [lead(1, { createdAt: "2026-10-09T09:00:00.000Z" })] };
  const before = structuredClone(input);
  composeCaught(input);
  assert.deepEqual(input, before);
});
