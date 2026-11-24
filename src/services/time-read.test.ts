import assert from "node:assert/strict";
import { test } from "node:test";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { Db } from "../db/db.ts";
import { DEFAULT_TZ } from "../time.ts";
import type { Ctx } from "./change.ts";
import { addTimeEntry } from "./time-entries.ts";
import { listTime, periodOf, timeByClientMonth } from "./time-read.ts";
import { startTimer } from "./timer.ts";
import { setClientRate } from "./work-types.ts";

// Sun Nov 22, 9:00 PM in Los Angeles (already Monday in UTC).
const NOW = new Date("2026-11-23T05:00:00.000Z");
// Thu Nov 19, 10:00 AM in Los Angeles.
const THURSDAY = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: Db): Ctx => ({ db, now: NOW, actor: "owner", tool: "add_time_entry" });

test("this week starts Monday in the owner's timezone", () => {
  assert.deepEqual(periodOf("this_week", THURSDAY, DEFAULT_TZ), { from: "2026-11-16", to: "2026-11-22" });
  assert.deepEqual(periodOf("last_week", THURSDAY, DEFAULT_TZ), { from: "2026-11-09", to: "2026-11-15" });
  assert.deepEqual(periodOf("this_month", THURSDAY, DEFAULT_TZ), { from: "2026-11-01", to: "2026-11-30" });
  assert.deepEqual(periodOf("last_month", THURSDAY, DEFAULT_TZ), { from: "2026-10-01", to: "2026-10-31" });
  // Sunday 9:00 PM in Los Angeles is already Monday in UTC: still the week of Nov 16 for the owner.
  assert.deepEqual(periodOf("this_week", NOW, DEFAULT_TZ), { from: "2026-11-16", to: "2026-11-22" });
  assert.deepEqual(periodOf("this_week", NOW, "UTC"), { from: "2026-11-23", to: "2026-11-29" });
  // A Monday is the first day of its own week; January's last month is December.
  assert.deepEqual(periodOf("this_week", new Date("2026-11-16T18:00:00.000Z"), DEFAULT_TZ), { from: "2026-11-16", to: "2026-11-22" });
  assert.deepEqual(periodOf("last_month", new Date("2027-01-15T18:00:00.000Z"), DEFAULT_TZ), { from: "2026-12-01", to: "2026-12-31" });
  assert.deepEqual(periodOf("this_month", new Date("2028-02-10T18:00:00.000Z"), DEFAULT_TZ), { from: "2028-02-01", to: "2028-02-29" });
});

async function seeded(): Promise<Db> {
  const db = await timeDb(NOW);
  const ctx = ctxFor(db);
  await setClientRate({ ...ctx, tool: "set_client_rate" }, { workType: "Design", contact: "ct_seed03", hourlyRate: 120 });
  // Pat: 90 min Design on the deal (billable, $95), 30 min Admin on the person (not billable).
  await addTimeEntry(ctx, { deal: "dl_seed01", startedAt: "2026-11-17T09:00", minutes: 90, workType: "Design" });
  await addTimeEntry(ctx, { contact: "ct_seed01", startedAt: "2026-11-18T09:00", minutes: 30, workType: "Admin" });
  // Casey: 60 min Design at Casey's own rate, $120. Sunday evening counts in the week.
  await addTimeEntry(ctx, { contact: "ct_seed03", startedAt: "2026-11-22T19:30", minutes: 60, workType: "Design" });
  // No one's: 15 min, not billable.
  await addTimeEntry(ctx, { startedAt: "2026-11-19T08:00", minutes: 15 });
  // Outside this week: last Sunday night.
  await addTimeEntry(ctx, { contact: "ct_seed01", startedAt: "2026-11-15T23:30", minutes: 20, workType: "Design" });
  // An archived entry never counts; a running timer is not an entry yet.
  const gone = await addTimeEntry(ctx, { contact: "ct_seed01", startedAt: "2026-11-18T12:00", minutes: 45, workType: "Design" });
  await db.prepare("UPDATE time_entries SET archived = 1 WHERE id = ?").bind(gone.entryId).run();
  await startTimer({ ...ctx, tool: "start_timer" }, { contact: "ct_seed01" });
  return db;
}

test("totals by person and deal, billable vs not", async () => {
  const db = await seeded();
  const week = await listTime(db, { period: periodOf("this_week", NOW, DEFAULT_TZ) }, DEFAULT_TZ);
  assert.equal(week.entries.length, 4);
  assert.deepEqual(week.entries.map((e) => e.minutes), [90, 30, 15, 60], "oldest first");
  assert.equal(week.totalMinutes, 195);
  assert.equal(week.billableMinutes, 150);
  assert.equal(week.billableAmount, 262.5, "$142.50 + $120.00");
  assert.deepEqual(week.byPerson, [
    { id: "ct_seed01", label: "Pat Example", minutes: 120, billableMinutes: 90, amount: 142.5 },
    { id: "ct_seed03", label: "Casey Placeholder", minutes: 60, billableMinutes: 60, amount: 120 },
    { id: null, label: "No person", minutes: 15, billableMinutes: 0, amount: 0 },
  ]);
  assert.deepEqual(week.byDeal, [{ id: "dl_seed01", label: '"Website refresh for Example Plumbing"', minutes: 90, billableMinutes: 90, amount: 142.5 }]);
  const first = week.entries[0];
  assert.deepEqual(first, {
    id: first?.id,
    startedAt: "2026-11-17T17:00:00.000Z",
    endedAt: "2026-11-17T18:30:00.000Z",
    minutes: 90,
    workTypeId: "wt_design",
    workType: "Design",
    billable: true,
    rate: 95,
    amount: 142.5,
    contactId: "ct_seed01",
    contact: "Pat Example",
    dealId: "dl_seed01",
    deal: '"Website refresh for Example Plumbing"',
    taskId: null,
    notes: null,
    untrusted_fields: [],
  });

  const pat = await listTime(db, { period: periodOf("this_week", NOW, DEFAULT_TZ), contact: "Pat Example" }, DEFAULT_TZ);
  assert.deepEqual(pat.entries.map((e) => e.minutes), [90, 30]);
  const deal = await listTime(db, { period: { from: "2026-11-01", to: "2026-11-30" }, deal: "dl_seed01" }, DEFAULT_TZ);
  assert.equal(deal.totalMinutes, 90);
});

test("an outside name is shown by id", async () => {
  const db = await timeDb(NOW);
  await addTimeEntry(ctxFor(db), { contact: "ct_seed02", startedAt: "2026-11-19T08:00", minutes: 30 });
  const list = await listTime(db, { period: periodOf("this_week", NOW, DEFAULT_TZ) }, DEFAULT_TZ);
  assert.equal(list.entries[0]?.contact, "contact ct_seed02");
  assert.equal(list.byPerson[0]?.label, "contact ct_seed02");
});

test("client and month rows", async () => {
  const db = await seeded();
  const rows = await timeByClientMonth(db, "2026-11", DEFAULT_TZ);
  assert.deepEqual(rows, [
    { contactId: "ct_seed01", contact: "Pat Example", entries: 3, minutes: 140, billableMinutes: 110, amount: 174.17 },
    { contactId: "ct_seed03", contact: "Casey Placeholder", entries: 1, minutes: 60, billableMinutes: 60, amount: 120 },
    { contactId: null, contact: "No person", entries: 1, minutes: 15, billableMinutes: 0, amount: 0 },
  ]);
  assert.deepEqual(await timeByClientMonth(db, "2026-10", DEFAULT_TZ), []);
  await assert.rejects(timeByClientMonth(db, "2026-13", DEFAULT_TZ), /^UserError: "2026-13" isn't a month I can read\. Use YYYY-MM, for example 2026-11\.$/);
});

test("reads refuse while time tracking is off", async () => {
  const db = await timeDb(NOW, { on: false });
  const off = /^UserError: Time tracking is off\./;
  await assert.rejects(listTime(db, { period: periodOf("this_week", NOW, DEFAULT_TZ) }, DEFAULT_TZ), off);
  await assert.rejects(timeByClientMonth(db, "2026-11", DEFAULT_TZ), off);
});
