import assert from "node:assert/strict";
import { test } from "node:test";
import { countOf, timeDb } from "../../tests/helpers/time-seed.ts";
import type { Db, TimeEntryRow } from "../db/db.ts";
import type { Ctx } from "./change.ts";
import { addTimeEntry, rateFor, updateTimeEntry } from "./time-entries.ts";
import { undoChange } from "./undo.ts";
import { setClientRate, updateWorkType } from "./work-types.ts";

// Thu Nov 19, 10:00 AM in Los Angeles.
const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: Db, tool = "add_time_entry"): Ctx => ({ db, now: NOW, actor: "owner", tool });
const entry = (db: Db, id: string) => db.prepare("SELECT * FROM time_entries WHERE id = ?").bind(id).first<TimeEntryRow>();

test("entry from start and end", async () => {
  const db = await timeDb(NOW);
  const result = await addTimeEntry(ctxFor(db), {
    contact: "ct_seed01",
    startedAt: "2026-11-19T07:30",
    endedAt: "2026-11-19T09:00",
    workType: "Design",
    notes: "Homepage sketches.",
  });
  assert.match(result.entryId, /^te_[a-z2-7]{12}$/);
  assert.match(
    result.summary,
    /^Added time 1 h 30 min, Design, billable at \$95\.00\/h \(\$142\.50\), for Pat Example, started Thu Nov 19, 7:30 AM \(change chg_[a-z0-9]{12}\)$/,
  );
  const row = await entry(db, result.entryId);
  assert.deepEqual(
    {
      started: row?.started_at,
      ended: row?.ended_at,
      minutes: row?.minutes,
      contact: row?.contact_id,
      deal: row?.deal_id,
      type: row?.work_type_id,
      billable: row?.billable,
      rate: row?.rate,
      notes: row?.notes,
      archived: row?.archived,
      untrusted: row?.untrusted_fields,
      version: row?.version,
    },
    {
      started: "2026-11-19T15:30:00.000Z",
      ended: "2026-11-19T17:00:00.000Z",
      minutes: 90,
      contact: "ct_seed01",
      deal: null,
      type: "wt_design",
      billable: 1,
      rate: 95,
      notes: "Homepage sketches.",
      archived: 0,
      untrusted: "[]",
      version: 1,
    },
  );
});

test("entry from start and minutes", async () => {
  const db = await timeDb(NOW);
  const result = await addTimeEntry(ctxFor(db), { startedAt: "2026-11-19T08:00", minutes: 45 });
  assert.match(result.summary, /^Added time 45 min, not billable, started Thu Nov 19, 8:00 AM \(change /);
  const row = await entry(db, result.entryId);
  assert.equal(row?.ended_at, "2026-11-19T16:45:00.000Z");
  assert.equal(row?.minutes, 45);
  assert.equal(row?.contact_id, null, "an entry may belong to no one");
  assert.equal(row?.billable, 0, "no work type: not billable unless asked");
  assert.equal(row?.rate, null);

  // A start and an end in seconds round the length up to the whole minute.
  const odd = await addTimeEntry(ctxFor(db), { startedAt: "2026-11-19T15:00:00Z", endedAt: "2026-11-19T15:00:01Z" });
  assert.equal((await entry(db, odd.entryId))?.minutes, 1);
});

test("end before start is refused", async () => {
  const db = await timeDb(NOW);
  const before = await countOf(db, "time_entries");
  const refused = async (input: Parameters<typeof addTimeEntry>[1], message: RegExp) =>
    assert.rejects(addTimeEntry(ctxFor(db), input), message);
  await refused({ startedAt: "2026-11-19T09:00", endedAt: "2026-11-19T08:00" }, /^UserError: The end must be after the start\. Edit the start or end\.$/);
  await refused({ startedAt: "2026-11-19T09:00", endedAt: "2026-11-19T09:00" }, /The end must be after the start/);
  await refused({ startedAt: "2026-11-18T07:00", endedAt: "2026-11-19T07:01" }, /^UserError: A time entry can be at most 16 hours; this one is 24 h 1 min\. Edit the start or end\.$/);
  await refused({ startedAt: "2026-11-19T09:00", minutes: 961 }, /at most 16 hours/);
  await refused({ startedAt: "2026-11-19T09:00", minutes: 0 }, /^UserError: Minutes must be a whole number from 1 to 960 \(16 hours\)\.$/);
  await refused({ startedAt: "2026-11-19T09:00", minutes: 1.5 }, /whole number/);
  await refused({ startedAt: "2026-11-19T09:00", endedAt: "2026-11-19T09:30", minutes: 30 }, /^UserError: Give endedAt or minutes, not both\.$/);
  await refused({ startedAt: "2026-11-19T09:00" }, /^UserError: A time entry needs an end \(endedAt\) or a length in minutes\.$/);
  await refused({ startedAt: "2026-11-19T09:30", minutes: 60 }, /^UserError: A time entry can't end in the future\. Add it once the work is done, or start a timer\.$/);
  await refused({ startedAt: "2026-11-19T08:00", minutes: 30, workType: "Coding" }, /^UserError: There's no work type "Coding"\. Work types: Design, Admin\./);
  assert.equal(await countOf(db, "time_entries"), before, "nothing written");
});

test("a deal's person is the entry's person, and a task's deal and person are used when none is given", async () => {
  const db = await timeDb(NOW);
  const onDeal = await addTimeEntry(ctxFor(db), { deal: "dl_seed01", startedAt: "2026-11-19T08:00", minutes: 30, workType: "Design" });
  assert.match(onDeal.summary, /for "Website refresh for Example Plumbing" \(Pat Example\), started/);
  const row = await entry(db, onDeal.entryId);
  assert.deepEqual([row?.deal_id, row?.contact_id], ["dl_seed01", "ct_seed01"]);

  const onTask = await addTimeEntry(ctxFor(db), { task: "tk_seed01", startedAt: "2026-11-19T08:30", minutes: 15 });
  const fromTask = await entry(db, onTask.entryId);
  assert.deepEqual([fromTask?.task_id, fromTask?.deal_id, fromTask?.contact_id], ["tk_seed01", "dl_seed01", "ct_seed01"]);

  await assert.rejects(
    addTimeEntry(ctxFor(db), { deal: "dl_seed01", contact: "ct_seed03", startedAt: "2026-11-19T08:00", minutes: 30 }),
    /belongs to Pat Example, not Casey Placeholder/,
  );
  await assert.rejects(
    addTimeEntry(ctxFor(db), { task: "tk_seed01", deal: "dl_seed03", startedAt: "2026-11-19T08:00", minutes: 30 }),
    /^UserError: Task "Prepare questions for Pat's call" is for "Website refresh for Example Plumbing" \(Pat Example\)\. Give just the task, or its own deal or person\.$/,
  );
  await assert.rejects(addTimeEntry(ctxFor(db), { task: "tk_nope", startedAt: "2026-11-19T08:00", minutes: 30 }), /No task "tk_nope"/);
});

test("client rate beats default", async () => {
  const db = await timeDb(NOW);
  await setClientRate(ctxFor(db, "set_client_rate"), { workType: "Design", contact: "ct_seed01", hourlyRate: 120 });
  assert.equal(await rateFor(db, "wt_design", "ct_seed01"), 120);
  assert.equal(await rateFor(db, "wt_design", "ct_seed03"), 95);
  assert.equal(await rateFor(db, "wt_design", null), 95);
  assert.equal(await rateFor(db, "wt_admin", "ct_seed01"), null);
  assert.equal(await rateFor(db, null, "ct_seed01"), null);

  const pat = await addTimeEntry(ctxFor(db), { contact: "Pat Example", startedAt: "2026-11-19T08:00", minutes: 60, workType: "design" });
  assert.match(pat.summary, /billable at \$120\.00\/h \(\$120\.00\)/);
  assert.equal((await entry(db, pat.entryId))?.rate, 120);
  const casey = await addTimeEntry(ctxFor(db), { contact: "ct_seed03", startedAt: "2026-11-19T08:00", minutes: 60, workType: "Design" });
  assert.equal((await entry(db, casey.entryId))?.rate, 95);
});

test("rate is kept after the work type's rate changes", async () => {
  const db = await timeDb(NOW);
  const added = await addTimeEntry(ctxFor(db), { contact: "ct_seed01", startedAt: "2026-11-19T08:00", minutes: 90, workType: "Design" });
  await updateWorkType(ctxFor(db, "update_work_type"), "Design", { hourlyRate: 110 });
  assert.equal((await entry(db, added.entryId))?.rate, 95, "a later rate change never rewrites an entry");

  const notes = await updateTimeEntry(ctxFor(db, "update_time_entry"), added.entryId, { notes: "Logo round two." });
  assert.match(notes.summary, /^Updated time entry te_[a-z2-7]{12}: now 1 h 30 min, Design, billable at \$95\.00\/h \(\$142\.50\), for Pat Example \(change /);
  assert.equal((await entry(db, added.entryId))?.rate, 95, "editing the notes keeps the rate");

  await updateTimeEntry(ctxFor(db, "update_time_entry"), added.entryId, { billable: true, minutes: 60 });
  assert.equal((await entry(db, added.entryId))?.rate, 110, "editing billable recomputes the rate from today's rates");
  await assert.rejects(updateTimeEntry(ctxFor(db, "update_time_entry"), added.entryId, { minutes: 60 }), /^UserError: Nothing to change on time entry te_[a-z2-7]{12}: every value you gave is already set\.$/);
});

test("not billable stores no rate", async () => {
  const db = await timeDb(NOW);
  const result = await addTimeEntry(ctxFor(db), { contact: "ct_seed01", startedAt: "2026-11-19T08:00", minutes: 30, workType: "Design", billable: false });
  assert.match(result.summary, /^Added time 30 min, Design, not billable, for Pat Example, /);
  const row = await entry(db, result.entryId);
  assert.deepEqual([row?.billable, row?.rate], [0, null]);

  // Admin is not billable by default; asked for, it is billable with no rate.
  const admin = await addTimeEntry(ctxFor(db), { startedAt: "2026-11-19T08:00", minutes: 30, workType: "Admin", billable: true });
  assert.match(admin.summary, /^Added time 30 min, Admin, billable, no rate, started /);
  assert.deepEqual([(await entry(db, admin.entryId))?.billable, (await entry(db, admin.entryId))?.rate], [1, null]);

  // Turning billable off on an entry clears its rate.
  const billable = await addTimeEntry(ctxFor(db), { startedAt: "2026-11-19T08:00", minutes: 30, workType: "Design" });
  await updateTimeEntry(ctxFor(db, "update_time_entry"), billable.entryId, { billable: false });
  assert.equal((await entry(db, billable.entryId))?.rate, null);
});

test("undo of an entry", async () => {
  const db = await timeDb(NOW);
  const undo = (id: string) => undoChange(ctxFor(db, "undo_change"), id);
  const added = await addTimeEntry(ctxFor(db), { contact: "ct_seed01", startedAt: "2026-11-19T08:00", minutes: 30, workType: "Design" });
  const edited = await updateTimeEntry(ctxFor(db, "update_time_entry"), added.entryId, { startedAt: "2026-11-19T07:00" });
  const moved = await entry(db, added.entryId);
  assert.deepEqual([moved?.started_at, moved?.ended_at, moved?.minutes], ["2026-11-19T15:00:00.000Z", "2026-11-19T16:30:00.000Z", 90], "moving the start keeps the end");

  assert.match((await undo(edited.changeId)).summary, /^Undid chg_[a-z0-9]{12}: Put back the earlier started at and minutes on time entry te_/);
  assert.deepEqual([(await entry(db, added.entryId))?.started_at, (await entry(db, added.entryId))?.minutes], ["2026-11-19T16:00:00.000Z", 30]);

  const archived = await updateTimeEntry(ctxFor(db, "update_time_entry"), added.entryId, { archived: true });
  assert.match(archived.summary, /^Archived time entry te_[a-z2-7]{12} \(30 min, Design, /);
  await assert.rejects(updateTimeEntry(ctxFor(db, "update_time_entry"), added.entryId, { minutes: 20 }), /is archived\. Restore it first \(archived false\)\./);
  await undo(archived.changeId);
  assert.equal((await entry(db, added.entryId))?.archived, 0);

  // The add itself can't be undone once the entry changed since; a fresh one can.
  await assert.rejects(undo(added.changeId), /time entry te_[a-z2-7]{12} changed since/);
  const fresh = await addTimeEntry(ctxFor(db), { startedAt: "2026-11-19T09:00", minutes: 15 });
  assert.match((await undo(fresh.changeId)).summary, /^Undid chg_[a-z0-9]{12}: Removed time entry te_/);
  assert.equal(await entry(db, fresh.entryId), null);
});

test("an entry's person, deal or task can't be removed by an undo while the entry points at it", async () => {
  const db = await timeDb(NOW);
  const { addLead } = await import("./leads.ts");
  const lead = await addLead(ctxFor(db, "add_lead"), { name: "Lee Example" });
  await addTimeEntry(ctxFor(db), { contact: lead.contactId, startedAt: "2026-11-19T08:00", minutes: 30 });
  await assert.rejects(undoChange(ctxFor(db, "undo_change"), lead.changeId), /other records now depend on it \(1 time entry\)/);
});

test("time entries refuse while time tracking is off", async () => {
  const db = await timeDb(NOW, { on: false });
  const off = /^UserError: Time tracking is off\. The owner can turn it on \(update_settings timeTracking true\)\.$/;
  await assert.rejects(addTimeEntry(ctxFor(db), { startedAt: "2026-11-19T08:00", minutes: 30 }), off);
  await assert.rejects(updateTimeEntry(ctxFor(db), "te_x", { minutes: 30 }), off);
});
