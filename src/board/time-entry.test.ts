// Hand entry, edit and archive on the board (decision 0051): each write is one audited change by the owner under the MCP
// tool's name, undoable, and answers 303 to the week the entry is in with ?change=.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, auditOf, changeIdOf, devEnv, formFields, h1Count, load, post } from "../../tests/helpers/board.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { TimeEntryRow } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { addDays, DEFAULT_TZ, localDate, zonedToUtc } from "../time.ts";

const yesterday = addDays(localDate(new Date(), DEFAULT_TZ), -1);
const entries = async (db: SqliteD1) => (await db.prepare("SELECT * FROM time_entries ORDER BY created_at, id").all<TimeEntryRow>()).results;
const entryRow = async (db: SqliteD1, id: string) => db.prepare("SELECT * FROM time_entries WHERE id = ?").bind(id).first<TimeEntryRow>();

async function seeded(): Promise<SqliteD1> {
  const db = await timeDb(new Date());
  const start = zonedToUtc(`${yesterday}T09:00`, DEFAULT_TZ);
  db.exec(
    `INSERT INTO time_entries (id, contact_id, deal_id, started_at, ended_at, minutes, work_type_id, billable, rate, notes)
     VALUES ('te_edit01', 'ct_seed01', 'dl_seed01', '${start.toISOString()}', '${new Date(start.getTime() + 90 * 60_000).toISOString()}', 90, 'wt_design', 1, 95, 'Sketched the plan.')`,
  );
  return db;
}

test("hand entry saves and shows Undo", async () => {
  const db = await timeDb(new Date());
  const env = devEnv(db);
  const before = await auditCount(db);
  const { res, location } = await post(env, "/time/new", {
    person: "ct_seed01",
    deal: "dl_seed01",
    work_type: "wt_design",
    "started.date": yesterday,
    "started.time": "09:00",
    "ended.date": yesterday,
    "ended.time": "10:30",
    billable: "",
    notes: "Walked the site.",
  });
  assert.equal(res.status, 303);
  assert.match(location, /^\/time\?week=\d{4}-\d{2}-\d{2}&change=chg_[a-z0-9]{12}$/);
  assert.equal(await auditCount(db), before + 1);
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, "add_time_entry");
  const [row] = await entries(db);
  assert.equal(row?.minutes, 90);
  assert.equal(row?.contact_id, "ct_seed01");
  assert.equal(row?.deal_id, "dl_seed01");
  assert.equal(row?.billable, 1, "Design is billable by default");
  assert.equal(row?.rate, 95);
  assert.equal(row?.notes, "Walked the site.");
  const shown = await load(env, location);
  assert.equal(shown.res.status, 200);
  assert.match(shown.body, /Undo/);
  assert.match(shown.body, new RegExp(`href="/time/${row?.id}/edit"`));
});

test("hand entry by minutes, not billable by choice, for no one", async () => {
  const db = await timeDb(new Date());
  const { res } = await post(devEnv(db), "/time/new", {
    "started.date": yesterday,
    "started.time": "14:00",
    minutes: "45",
    work_type: "wt_design",
    billable: "0",
  });
  assert.equal(res.status, 303);
  const [row] = await entries(db);
  assert.equal(row?.minutes, 45);
  assert.equal(row?.billable, 0, "Not billable wins over the work type's default");
  assert.equal(row?.contact_id, null);
});

test("a refused hand entry is a 422 with the form again and the values kept, and writes nothing", async () => {
  const db = await timeDb(new Date());
  const before = await auditCount(db);
  const none = await post(devEnv(db), "/time/new", { "started.date": yesterday, "started.time": "09:00", notes: "Kept text." });
  assert.equal(none.res.status, 422);
  assert.match(none.body, /needs an end/);
  assert.match(none.body, /Kept text\./);
  assert.equal(h1Count(none.body), 1);
  const both = await post(devEnv(db), "/time/new", { "started.date": yesterday, "started.time": "09:00", "ended.time": "10:00", "ended.date": yesterday, minutes: "30" });
  assert.equal(both.res.status, 422);
  assert.match(both.body, /not both/);
  const noStart = await post(devEnv(db), "/time/new", { minutes: "30" });
  assert.equal(noStart.res.status, 422);
  assert.match(noStart.body, /Give the start/);
  const dateOnly = await post(devEnv(db), "/time/new", { "started.date": yesterday, minutes: "30" });
  assert.equal(dateOnly.res.status, 422);
  assert.match(dateOnly.body, /Give the time too\./);
  assert.equal(await auditCount(db), before);
  assert.equal((await entries(db)).length, 0);
});

test("the new form: person and deal selects with a blank first option, work type, start, end or minutes, billing, notes", async () => {
  const db = await timeDb(new Date());
  const { body } = await load(devEnv(db), "/time/new");
  assert.equal(h1Count(body), 1);
  assert.match(body, /<select id="time-person" name="person"[^>]*>\n<option value="" selected>No one<\/option>/);
  assert.match(body, /<option value="ct_seed01">Pat Example<\/option>/);
  assert.match(body, /<select id="time-deal" name="deal">\n<option value="" selected>No deal<\/option>/);
  assert.match(body, /<option value="dl_seed01">Website refresh for Example Plumbing<\/option>/);
  assert.match(body, /<select id="time-work_type" name="work_type">\n<option value="" selected>None<\/option>\n<option value="wt_design">Design<\/option>/);
  assert.match(body, /name="started\.date"/);
  assert.match(body, /name="ended\.date"/);
  assert.match(body, /id="time-minutes" name="minutes"/);
  assert.match(body, /<select id="time-billable" name="billable">\n<option value="" selected>Follow the work type<\/option>\n<option value="1">Billable<\/option>\n<option value="0">Not billable<\/option>/);
  assert.match(body, /<textarea id="time-notes" name="notes"/);
  assert.match(body, /<button class="button" type="submit">Save time<\/button>/);
  assert.match(body, /name="csrf"/);
});

test("an outside name is an id in the selects, never the text", async () => {
  const db = await timeDb(new Date());
  const { body } = await load(devEnv(db), "/time/new");
  assert.match(body, /<option value="ct_seed02">contact ct_seed02<\/option>/);
  assert.match(body, /<option value="dl_seed02">deal dl_seed02<\/option>/);
});

test("the edit form shows the stored values, with Archive on its own form", async () => {
  const db = await seeded();
  const { res, body } = await load(devEnv(db), "/time/te_edit01/edit");
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<option value="ct_seed01" selected>Pat Example<\/option>/);
  assert.match(body, /<option value="wt_design" selected>Design<\/option>/);
  assert.match(body, /name="started\.date" type="date" value="\d{4}-\d{2}-\d{2}"/);
  assert.match(body, /<select id="time-billable" name="billable">\n<option value="1" selected>Billable<\/option>\n<option value="0">Not billable<\/option>/);
  assert.match(body, /Sketched the plan\./);
  assert.match(body, /<form[^>]*action="\/time\/te_edit01\/archive"/);
  assert.match(body, /<button class="button button-quiet" type="submit">Archive this entry<\/button>/);
});

test("edit changes the rate only when billable or work type changes", async () => {
  const db = await seeded();
  const env = devEnv(db);
  const path = "/time/te_edit01/edit";
  const send = async (change: (fields: URLSearchParams) => void) => {
    const page = await load(env, path);
    const fields = formFields(page.body, path);
    change(fields);
    return post(env, path, fields, { cookie: page.cookie, token: page.token });
  };
  // Today's work type rate moves to 120; the stored entry keeps the 95 it was saved with.
  db.exec("UPDATE work_types SET hourly_rate = 120 WHERE id = 'wt_design'");

  const notes = await send((fields) => fields.set("notes", "Sketched the plan, then the section."));
  assert.equal(notes.res.status, 303);
  assert.equal((await entryRow(db, "te_edit01"))?.rate, 95, "a notes edit leaves the rate");
  assert.equal((await entryRow(db, "te_edit01"))?.notes, "Sketched the plan, then the section.");
  const audit = await auditOf(db, changeIdOf(notes.location));
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, "update_time_entry");

  const longer = await send((fields) => fields.set("ended.time", "11:00"));
  assert.equal(longer.res.status, 303);
  const afterTime = await entryRow(db, "te_edit01");
  assert.equal(afterTime?.minutes, 120, "the end moved");
  assert.equal(afterTime?.rate, 95, "a time edit leaves the rate");

  const admin = await send((fields) => fields.set("work_type", "wt_admin"));
  assert.equal(admin.res.status, 303);
  assert.equal((await entryRow(db, "te_edit01"))?.rate, null, "Admin has no rate");

  const design = await send((fields) => fields.set("work_type", "wt_design"));
  assert.equal(design.res.status, 303);
  assert.equal((await entryRow(db, "te_edit01"))?.rate, 120, "back to Design: today's rate");

  const off = await send((fields) => fields.set("billable", "0"));
  assert.equal(off.res.status, 303);
  const unbilled = await entryRow(db, "te_edit01");
  assert.equal(unbilled?.billable, 0);
  assert.equal(unbilled?.rate, null);
});

test("saving an edit with nothing changed is a refusal that says so, and writes nothing", async () => {
  const db = await seeded();
  const env = devEnv(db);
  const path = "/time/te_edit01/edit";
  const page = await load(env, path);
  const before = await auditCount(db);
  const same = await post(env, path, formFields(page.body, path), { cookie: page.cookie, token: page.token });
  assert.equal(same.res.status, 422);
  assert.match(same.body, /Nothing to save/);
  assert.equal(await auditCount(db), before);
});

test("archive hides the entry", async () => {
  const db = await seeded();
  const env = devEnv(db);
  const week = await load(env, `/time?week=${addDays(yesterday, 0)}`);
  assert.match(week.body, /te_edit01/);
  const page = await load(env, "/time/te_edit01/edit");
  const { res, location } = await post(env, "/time/te_edit01/archive", {}, { cookie: page.cookie, token: page.token });
  assert.equal(res.status, 303);
  assert.match(location, /^\/time\?week=\d{4}-\d{2}-\d{2}&change=chg_[a-z0-9]{12}$/);
  assert.equal((await entryRow(db, "te_edit01"))?.archived, 1);
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.tool, "update_time_entry");
  assert.equal(audit?.actor, "owner");
  const after = await load(env, location);
  assert.doesNotMatch(after.body.replace(/Undo[\s\S]*$/, ""), /href="\/time\/te_edit01\/edit"/);
  assert.match(after.body, /Undo/);
  assert.equal((await load(env, "/time/te_edit01/edit")).res.status, 404, "an archived entry has no edit page");
});

test("an entry that is not there, a malformed id or a running timer is a 404", async () => {
  const db = await seeded();
  const env = devEnv(db);
  db.exec("INSERT INTO time_entries (id, contact_id, started_at, billable) VALUES ('te_run001', 'ct_seed01', '2026-01-01T10:00:00.000Z', 0)");
  for (const path of ["/time/te_nope/edit", "/time/%3Cb%3E/edit", "/time/te_run001/edit"]) {
    assert.equal((await load(env, path)).res.status, 404, path);
  }
  for (const path of ["/time/te_nope/archive", "/time/te_nope/edit", "/time/te_run001/archive"]) {
    assert.equal((await post(env, path, { notes: "x" })).res.status, 404, path);
  }
});

test("time tracking off: the write paths are 404 and write nothing", async () => {
  const db = await timeDb(new Date(), { on: false });
  const env = devEnv(db);
  const before = await auditCount(db);
  assert.equal((await post(env, "/time/new", { "started.date": yesterday, "started.time": "09:00", minutes: "30" })).res.status, 404);
  assert.equal((await post(env, "/time/te_x/edit", { notes: "x" })).res.status, 404);
  assert.equal((await post(env, "/time/te_x/archive", {})).res.status, 404);
  assert.equal(await auditCount(db), before);
});
