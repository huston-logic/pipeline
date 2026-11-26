// One-tap Stop, discarding the timer, and Edit or add notes (run 12), through the Worker. Each write is one audited change by
// the owner under the service tool's name; with time tracking off every path is a 404.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, auditOf, changeIdOf, devEnv, h1Count, load, post } from "../../tests/helpers/board.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { TimeEntryRow } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";

const entries = async (db: SqliteD1) => (await db.prepare("SELECT * FROM time_entries ORDER BY created_at, id").all<TimeEntryRow>()).results;
const started = (db: SqliteD1, extra: Record<string, string> = {}) =>
  post(devEnv(db), "/timer/start", { contact: "ct_seed01", return_to: "/contacts/ct_seed01", ...extra });

/** A timer that has been running `minutes`. */
async function running(minutes: number) {
  const db = await timeDb(new Date());
  await started(db);
  db.exec(`UPDATE time_entries SET started_at = '${new Date(Date.now() - minutes * 60_000).toISOString()}'`);
  return db;
}

test("POST /timer/stop/now stops with the timer's own details and goes back with the change", async () => {
  const db = await running(12);
  const { res, location } = await post(devEnv(db), "/timer/stop/now", { return_to: "/contacts/ct_seed01" });
  assert.equal(res.status, 303);
  assert.match(location, /^\/contacts\/ct_seed01\?change=chg_[a-z0-9]{12}$/);
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, "stop_timer");
  const [entry] = await entries(db);
  assert.ok((entry?.minutes ?? 0) >= 12 && (entry?.minutes ?? 0) <= 13, "the timer's own start to now");
  assert.ok(entry?.ended_at !== null);
});

test("a second stop says no timer is running and writes nothing", async () => {
  const db = await running(3);
  await post(devEnv(db), "/timer/stop/now", { return_to: "/" });
  const before = await auditCount(db);
  const again = await post(devEnv(db), "/timer/stop/now", { return_to: "/" });
  assert.equal(again.res.status, 422);
  assert.match(again.body, /The timer wasn&#39;t stopped|The timer wasn't stopped/);
  assert.match(again.body, /No timer is running\./);
  assert.equal(h1Count(again.body), 1);
  assert.equal(await auditCount(db), before);
});

test("a valid at comes back as a fragment and a bad one is ignored", async () => {
  const db = await timeDb(new Date());
  const ok = await started(db, { at: "task-tk_seed01" });
  assert.match(ok.location, /^\/contacts\/ct_seed01\?change=chg_[a-z0-9]{12}#task-tk_seed01$/);
  const stopped = await post(devEnv(db), "/timer/stop/now", { return_to: "/", at: "Bad Anchor" });
  assert.match(stopped.location, /^\/\?change=chg_[a-z0-9]{12}$/);
});

test("discarding a timer that ran over five minutes asks first, then cancels on confirm", async () => {
  const db = await running(12);
  const before = await auditCount(db);
  const asked = await post(devEnv(db), "/timer/cancel", { return_to: "/contacts/ct_seed01" });
  assert.equal(asked.res.status, 200);
  assert.equal(h1Count(asked.body), 1);
  assert.match(asked.body, /<h1>Discard the timer\?<\/h1>/);
  assert.match(asked.body, /It has run 12 min\. Nothing will be logged\./);
  assert.match(asked.body, /Discard timer<\/button>/);
  assert.match(asked.body, /name="confirm" value="yes"/);
  assert.match(asked.body, /name="return_to" value="\/contacts\/ct_seed01"/);
  assert.match(asked.body, /<a class="confirm-cancel" href="\/contacts\/ct_seed01">Keep it<\/a>/);
  assert.equal(await auditCount(db), before);
  assert.equal((await entries(db))[0]?.archived, 0);

  const done = await post(devEnv(db), "/timer/cancel", { return_to: "/contacts/ct_seed01", confirm: "yes" });
  assert.equal(done.res.status, 303);
  assert.match(done.location, /^\/contacts\/ct_seed01\?change=chg_[a-z0-9]{12}$/);
  assert.equal((await auditOf(db, changeIdOf(done.location)))?.tool, "cancel_timer");
  assert.equal((await entries(db))[0]?.archived, 1);
});

test("discarding a timer under five minutes needs no question; none running is a refusal", async () => {
  const db = await running(2);
  const done = await post(devEnv(db), "/timer/cancel", { return_to: "/" });
  assert.equal(done.res.status, 303);
  assert.equal((await entries(db))[0]?.archived, 1);
  const none = await post(devEnv(db), "/timer/cancel", { return_to: "/" });
  assert.equal(none.res.status, 422);
  assert.match(none.body, /No timer is running\./);
});

/** A saved entry with notes, and the change that stopped it. */
async function saved() {
  const db = await timeDb(new Date());
  await started(db);
  const stopped = await post(devEnv(db), "/timer/stop", { notes: "First pass.", work_type: "wt_design", "was.billable": "0" });
  const entry = /entry=(te_[a-z0-9]{12})/.exec(stopped.location)?.[1] ?? "";
  return { db, entry, stopChange: changeIdOf(stopped.location) };
}

test("the notes page shows the saved entry's fields, its span and Ask Claude", async () => {
  const { db, entry } = await saved();
  const { res, body } = await load(devEnv(db), `/timer/notes?entry=${entry}&back=/contacts/ct_seed01`);
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<h1>Edit or add notes<\/h1>/);
  assert.match(body, /Time logged: \d{1,2}:\d{2} [AP]M to \d{1,2}:\d{2} [AP]M/);
  assert.equal(body.match(/Time logged:/g)?.length, 1, "the corner's note is not repeated here");
  assert.match(body, /<textarea id="notes-notes" name="notes"[^>]*>First pass\.<\/textarea>/);
  assert.match(body, /<option value="wt_design" selected>/);
  assert.match(body, /name="billable" type="checkbox" value="yes" checked/);
  for (const name of ["next_step", "started.date", "started.time", "ended.date", "ended.time", "was.started", "was.ended", "was.notes", "was.work_type"]) {
    assert.match(body, new RegExp(`name="${name.replace(".", "\\.")}"`), name);
  }
  assert.match(body, new RegExp(`name="entry" value="${entry}"`));
  assert.match(body, /name="back" value="\/contacts\/ct_seed01"/);
  assert.match(body, />Save<\/button>/);
  assert.match(body, /<a class="confirm-cancel" href="\/contacts\/ct_seed01">Cancel<\/a>/);
  assert.match(body, /Ask Claude to turn these notes into updates/);
});

test("the notes page is a 404 off, for a running or archived entry, and for a bad id", async () => {
  const off = await timeDb(new Date(), { on: false });
  assert.equal((await load(devEnv(off), "/timer/notes?entry=te_x")).res.status, 404);
  const db = await running(3);
  const [open] = await entries(db);
  assert.equal((await load(devEnv(db), `/timer/notes?entry=${open?.id}`)).res.status, 404, "running");
  assert.equal((await load(devEnv(db), "/timer/notes?entry=te_nope")).res.status, 404);
  assert.equal((await load(devEnv(db), "/timer/notes?entry=<b>")).res.status, 404);
  const { db: db2, entry } = await saved();
  db2.exec("UPDATE time_entries SET archived = 1");
  assert.equal((await load(devEnv(db2), `/timer/notes?entry=${entry}`)).res.status, 404, "archived");
  assert.equal((await post(devEnv(off), "/timer/notes", { entry: "te_x" })).res.status, 404);
});

test("saving new notes calls log_time, sets the close cookie for the stop and goes back", async () => {
  const { db, entry, stopChange } = await saved();
  const page = await load(devEnv(db), `/timer/notes?entry=${entry}&back=/contacts/ct_seed01`);
  const was = (name: string) => new RegExp(`name="was\\.${name}" value="([^"]*)"`).exec(page.body)?.[1] ?? "";
  const before = await auditCount(db);
  const sent = await post(
    devEnv(db),
    "/timer/notes",
    { entry, back: "/contacts/ct_seed01", notes: "Second pass.", "was.notes": was("notes"), work_type: "wt_design", "was.work_type": was("work_type"), billable: "yes", "was.billable": "1" },
    { cookie: page.cookie, token: page.token },
  );
  assert.equal(sent.res.status, 303);
  assert.match(sent.location, /^\/contacts\/ct_seed01\?change=chg_[a-z0-9]{12}$/);
  assert.equal(await auditCount(db), before + 1);
  const audit = await auditOf(db, changeIdOf(sent.location));
  assert.equal(audit?.tool, "log_time");
  assert.equal(audit?.actor, "owner");
  assert.equal((await entries(db))[0]?.notes, "Second pass.");
  assert.match(sent.res.headers.get("Set-Cookie") ?? "", new RegExp(`^pipeline_corner=${stopChange}; HttpOnly; SameSite=Strict; Path=/; Max-Age=300`));
});

test("saving with nothing changed is a 422 with the form again; a bad back falls to the done page", async () => {
  const { db, entry } = await saved();
  const page = await load(devEnv(db), `/timer/notes?entry=${entry}&back=/`);
  const was = (name: string) => new RegExp(`name="was\\.${name}" value="([^"]*)"`).exec(page.body)?.[1] ?? "";
  const same = { entry, back: "/", notes: "First pass.", "was.notes": was("notes"), work_type: "wt_design", "was.work_type": was("work_type"), billable: "yes", "was.billable": "1" };
  const before = await auditCount(db);
  const refused = await post(devEnv(db), "/timer/notes", same, { cookie: page.cookie, token: page.token });
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /Nothing to save/);
  assert.match(refused.body, /First pass\./);
  assert.equal(h1Count(refused.body), 1);
  assert.equal(await auditCount(db), before);

  const out = await post(devEnv(db), "/timer/notes", { ...same, back: "https://evil.example/", notes: "Changed." }, { cookie: page.cookie, token: page.token });
  assert.equal(out.res.status, 303);
  assert.match(out.location, new RegExp(`^/timer/done\\?entry=${entry}&change=chg_[a-z0-9]{12}$`));
});
